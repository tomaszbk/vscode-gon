import type { GonTesting } from '../src/gon/testing';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { probeCapabilities, ToolingProbe } from '../src/gon/agentTooling';
import { checkCoreFeatures } from './coreFeatures';
import { findPublicTool } from '../src/gon/toolchain';

async function until<T>(action: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + message);
}

function taskDone(type = 'gon-run'): { promise: Promise<number | undefined>; dispose: () => void } {
  let disposable: vscode.Disposable;
  const promise = new Promise<number | undefined>((resolve) => {
    disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.type === type) {
        disposable.dispose();
        resolve(event.exitCode);
      }
    });
  });
  return {
    promise: Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Run task timed out')), 45000))
    ]),
    dispose: () => disposable.dispose()
  };
}

async function integration() {
  // macOS VS Code resolves the login-shell environment before starting the
  // host, which can replace the runner's PATH. Restore the isolated public
  // installation before opening documents or activating compiler services.
  process.env.PATH = process.env.GON_TEST_PUBLIC_BIN + path.delimiter + (process.env.PATH ?? '');
  const temporary = process.env.GON_TEST_ROOT!;
  const modern = path.join(temporary, 'gon project & spaces');
  const legacy = path.join(temporary, 'go project');
  const modernUri = vscode.Uri.file(path.join(modern, 'main.go'));
  const legacyUri = vscode.Uri.file(path.join(legacy, 'main.go'));
  // Discovery also works when a GUI editor has not inherited the new PATH.
  const home = path.join(temporary, 'discovery-home');
  const fallback = path.join(home, '.local', 'bin');
  await fs.mkdir(fallback, { recursive: true });
  await fs.symlink(path.join(process.env.GON_ROOT!, 'gon/bin/gon'), path.join(fallback, 'gon'));
  assert.equal(findPublicTool('gon', '', home), path.join(fallback, 'gon'));
  assert.equal(findPublicTool('gon', process.env.GON_TEST_PUBLIC_BIN!, home), path.join(process.env.GON_TEST_PUBLIC_BIN!, 'gon'));
  assert.equal(findPublicTool('gonpls', '', home), undefined, 'missing tools are not silently replaced');
  const directoryOnly = path.join(temporary, 'directory-only');
  await fs.mkdir(path.join(directoryOnly, 'gon'), { recursive: true });
  assert.equal(findPublicTool('gon', directoryOnly, home), path.join(fallback, 'gon'), 'directories are not executables');
  const extension = vscode.extensions.getExtension('gon-lang.gon');
  assert.ok(extension, 'Gon extension must be registered independently');
  await extension.activate();
  console.log('GON TEST: activated');
  for (const folder of [modern, legacy]) {
    assert.ok(!(await fs.stat(path.join(folder, '.vscode')).catch(() => undefined)), 'no project settings needed');
  }
  assert.ok(!('gon.enabled' in extension.packageJSON.contributes.configuration.properties));
  assert.ok(!extension.packageJSON.contributes.commands.some((c: { command: string }) => c.command === 'gon.enableWorkspace' || c.command === 'gon.disableWorkspace'));

  if (process.env.GON_TEST_SETUP_ONLY !== '1') {
    await checkCoreFeatures(extension, temporary);
  }
  if (process.env.GON_TEST_FEATURES_ONLY === '1') {
    return;
  }
  const manifest = extension.packageJSON;
  assert.equal(manifest.contributes.languages[0].extensions, undefined, 'must not claim all .go files globally');
  assert.ok(
    manifest.contributes.menus['editor/title'].some((item: { command: string }) => item.command === 'gon.runFile')
  );
  assert.equal(
    manifest.contributes.commands.find((c: { command: string }) => c.command === 'gon.runFile').icon,
    '$(play)'
  );
  let modernDocument = await vscode.workspace.openTextDocument(modernUri);
  await vscode.window.showTextDocument(modernDocument);
  await until(
    async () =>
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === modernUri.toString() && d.languageId === 'gon'),
    'Gon language selection'
  );
  modernDocument = await vscode.workspace.openTextDocument(modernUri);
  const legacyDocument = await vscode.workspace.openTextDocument(legacyUri);
  await vscode.window.showTextDocument(legacyDocument);
  await until(async () => {
    const doc = await vscode.workspace.openTextDocument(legacyUri);
    return doc.languageId === 'gon' ? true : undefined;
  }, 'existing Go project uses Gon without configuration');
  {
    const pos = legacyDocument.positionAt(legacyDocument.getText().indexOf('problem)'));
    await until(async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        legacyUri,
        pos
      );
      return hovers?.some((h) =>
        h.contents.some((c) => (typeof c === 'string' ? c.includes('error') : c.value.includes('error')))
      )
        ? true
        : undefined;
    }, 'gonpls hover in unconfigured legacy project');
    console.log('GON TEST: Gon extension uses Gon for existing Go code without settings');
  }
  console.log('GON TEST: automatic Gon selection');
  const hoverPosition = modernDocument.positionAt(modernDocument.getText().indexOf('problem)'));
  console.log(
    'GON TEST: hover target ' +
      modernDocument.languageId +
      ' ' +
      modernDocument.uri +
      ' ' +
      JSON.stringify(hoverPosition)
  );
  await until(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      modernUri,
      hoverPosition
    );
    return hovers?.some((h) =>
      h.contents.some((content) =>
        typeof content === 'string' ? content.includes('error') : content.value.includes('error')
      )
    )
      ? hovers
      : undefined;
  }, 'gonpls hover for the error binding');
  console.log('GON TEST: hover');
  const siblingUri = vscode.Uri.file(path.join(temporary, 'second gon project', 'main.go'));
  const siblingDocument = await vscode.workspace.openTextDocument(siblingUri);
  await vscode.window.showTextDocument(siblingDocument);
  await until(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      siblingUri,
      hoverPosition
    );
    return hovers?.length ? true : undefined;
  }, 'second Gon client without command collisions');
  for (const [uri, prefix] of [
    [modernUri, 'gonpls'],
    [siblingUri, 'gonpls'],
    [legacyUri, 'gonpls']
  ] as const) {
    const imports = await vscode.commands.executeCommand(`${prefix}.list_imports`, { URI: uri.toString() });
    assert.ok(JSON.stringify(imports).includes('fmt'), `server command routes to ${uri}`);
  }
  assert.equal(
    vscode.languages.getDiagnostics(modernUri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
    0
  );
  const initial = modernDocument.getText();
  const edit = new vscode.WorkspaceEdit();
  const index = initial.indexOf('return value + next, nil');
  edit.replace(
    modernUri,
    new vscode.Range(
      modernDocument.positionAt(index),
      modernDocument.positionAt(index + 'return value + next, nil'.length)
    ),
    'return "wrong" + next, nil'
  );
  await vscode.workspace.applyEdit(edit);
  await until(
    async () =>
      vscode.languages.getDiagnostics(modernUri).some((d) => d.severity === vscode.DiagnosticSeverity.Error)
        ? true
        : undefined,
    'real type error diagnostics'
  );
  const restore = new vscode.WorkspaceEdit();
  restore.replace(
    modernUri,
    new vscode.Range(modernDocument.positionAt(0), modernDocument.positionAt(modernDocument.getText().length)),
    initial
  );
  await vscode.workspace.applyEdit(restore);
  await until(
    async () =>
      vscode.languages.getDiagnostics(modernUri).every((d) => d.severity !== vscode.DiagnosticSeverity.Error)
        ? true
        : undefined,
    'diagnostics clear after repair'
  );
  console.log('GON TEST: diagnostics');

  // Only program arguments and Delve location are customized for later tests.
  // Tool selection and LSP have already worked without any project settings.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const settings = vscode.workspace.getConfiguration('gon', folder.uri);
    await settings.update('run.args', [folder.uri.fsPath], vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('debuggerPath', process.env.GON_TEST_DLV!, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  const testing = (extension.exports as { testing: GonTesting }).testing;
  await testing.refresh();
  console.log('GON TEST: discovered tests');
  function testItem(folder: string, name: string): vscode.TestItem {
    const root = testing.controller.items.get(vscode.Uri.file(folder).toString());
    assert.ok(root, 'test root');
    assert.equal(root.error, undefined, String(root.error));
    let item: vscode.TestItem | undefined;
    root.children.forEach((pkg) =>
      pkg.children.forEach((child) => {
        if (child.label === name) {
          item = child;
        }
      })
    );
    assert.ok(item, `discovered ${name} in ${folder}`);
    assert.ok(item.range, 'test source navigation');
    return item;
  }
  const token = new vscode.CancellationTokenSource();
  for (const folder of [modern, legacy]) {
    const result = await testing.run(
      new vscode.TestRunRequest(['TestOK', 'TestFailure', 'TestSkip'].map((n) => testItem(folder, n))),
      token.token
    );
    assert.ok(result.passed.includes('TestOK'), JSON.stringify(result));
    assert.ok(result.passed.includes('TestOK/nested'));
    assert.deepEqual(result.failed, ['TestFailure']);
    assert.deepEqual(result.skipped, ['TestSkip']);
    const parent = testItem(folder, 'TestOK');
    const excluded = parent.children.get(parent.id + '/nested')!;
    const filtered = await testing.run(new vscode.TestRunRequest([parent], [excluded]), token.token);
    assert.ok(filtered.passed.includes('TestOK/sibling'));
    assert.ok(!filtered.passed.includes('TestOK/nested'));
    const debugged = await testing.run(new vscode.TestRunRequest([testItem(folder, 'TestOK')]), token.token, true);
    assert.ok(debugged.passed.includes('TestOK'), JSON.stringify(debugged));
    assert.ok(debugged.passed.includes('TestOK/nested'), JSON.stringify(debugged));
    assert.deepEqual(debugged.failed, []);
    const failedDebug = await testing.run(
      new vscode.TestRunRequest([testItem(folder, 'TestFailure')]),
      token.token,
      true
    );
    assert.deepEqual(failedDebug.failed, ['TestFailure']);
    console.log('GON TEST: run/debug test explorer ' + folder);
  }
  const cancelled = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancelled.cancel(), 1500);
  const cancelledResult = await testing.run(new vscode.TestRunRequest([testItem(modern, 'TestSlow')]), cancelled.token);
  clearTimeout(timer);
  cancelled.dispose();
  assert.ok(cancelledResult.cancelled);
  token.dispose();
  for (const uri of [modernUri, legacyUri]) {
    const document = await vscode.workspace.openTextDocument(uri);
    const line = document.positionAt(document.getText().indexOf('return value + next, nil')).line;
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    const id = 'integration-' + uri.toString();
    let session: vscode.DebugSession | undefined;
    let stoppedCount = 0;
    let exit: number | undefined;
    let endedResolve: () => void;
    const ended = new Promise<void>((resolve) => {
      endedResolve = resolve;
    });
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(s) {
        if (s.configuration.gonIntegrationId !== id) {
          return;
        }
        session = s;
        return {
          onDidSendMessage(message: any) {
            if (message.event === 'stopped') {
              stoppedCount++;
            }
            if (message.event === 'exited') {
              exit = message.body.exitCode;
            }
          }
        };
      }
    });
    const endSub = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.configuration.gonIntegrationId === id) {
        endedResolve();
      }
    });
    try {
      const folder = vscode.workspace.getWorkspaceFolder(uri)!;
      assert.ok(
        await vscode.debug.startDebugging(folder, {
          type: uri === legacyUri ? 'go' : 'gon',
          request: 'launch',
          name: 'Gon debug integration',
          mode: 'debug',
          program: folder.uri.fsPath,
          cwd: folder.uri.fsPath,
          args: [folder.uri.fsPath],
          gonIntegrationId: id
        })
      );
      await until(async () => (stoppedCount > 0 ? true : undefined), 'debug breakpoint');
      const threads = await session!.customRequest('threads');
      const threadId = threads.threads[0].id;
      const stack = await session!.customRequest('stackTrace', { threadId });
      const frameId = stack.stackFrames[0].id;
      const value = await session!.customRequest('evaluate', { expression: 'value', frameId, context: 'watch' });
      assert.equal(value.result, '21');
      const scopes = await session!.customRequest('scopes', { frameId });
      assert.ok(scopes.scopes.length > 0);
      const variables = await session!.customRequest('variables', {
        variablesReference: scopes.scopes[0].variablesReference
      });
      assert.ok(variables.variables.some((v: any) => v.name === 'next'));
      await session!.customRequest('next', { threadId });
      await until(async () => (stoppedCount > 1 ? true : undefined), 'step over');
      await session!.customRequest('continue', { threadId });
      await ended;
      assert.equal(exit, 0);
      console.log('GON TEST: breakpoint, stack, locals, evaluate, step, continue ' + uri);
    } finally {
      vscode.debug.removeBreakpoints([breakpoint]);
      tracker.dispose();
      endSub.dispose();
      if (session) {
        await vscode.debug.stopDebugging(session);
      }
    }
  }

  // The actual registered play command must save, run, and preserve arguments
  // containing spaces and shell metacharacters, for legacy and modern code.
  for (const [uri, folder, command] of [
    [modernUri, modern, 'gon'],
    [legacyUri, legacy, 'gon']
  ] as const) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const done = taskDone();
    try {
      const execution = await vscode.commands.executeCommand<vscode.TaskExecution>('gon.runFile', uri);
      assert.ok(execution, 'Run command should start a task');
      const process = execution.task.execution as vscode.ProcessExecution;
      assert.ok(process.process.endsWith('/' + command), process.process);
      assert.deepEqual(process.args, ['run', uri.fsPath, folder]);
      assert.equal(await done.promise, 0, 'program must exit successfully');
      console.log('GON TEST: executed ' + command);
      assert.equal(await fs.readFile(path.join(folder, 'executed.txt'), 'utf8'), '42 <nil> 0 wrapped: failure\n');
    } finally {
      done.dispose();
    }
  }
  assert.ok(!modernDocument.isDirty, 'Run should save dirty code');
  // Agent tooling: capability detection and Check Project through gon check.
  {
    const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(commands.includes('gon.checkProject') && commands.includes('gon.showToolingCapabilities'));
    assert.ok(manifest.contributes.problemMatchers.some((m: { name: string }) => m.name === 'gon-check'));
    const api = extension.exports as { getToolingCapabilities(uri: vscode.Uri): Promise<ToolingProbe> };
    const probe = await api.getToolingCapabilities(modernUri);
    assert.ok(probe.available, JSON.stringify(probe));
    assert.equal(probe.result.schemaVersion, 1);
    assert.ok(probe.result.capabilities.check && probe.result.capabilities.rename);
    assert.equal(probe.result.toolchain.languageServer, path.join(process.env.GON_ROOT!, 'gon', 'bin', 'gonpls'));
    // A toolchain without the tooling commands is reported instead of used.
    const old = await probeCapabilities(process.env.GO_ERROR_HANDLING_BASELINE!, modern);
    assert.ok(!old.available && old.reason.includes('Update the selected Gon toolchain'), JSON.stringify(old));
    const brokenUri = vscode.Uri.file(path.join(modern, 'broken.go'));
    for (const [expected, broken] of [
      [0, false],
      [1, true]
    ] as const) {
      if (broken) {
        await fs.writeFile(
          brokenUri.fsPath,
          'package main\n\nfunc value() int { return 1 }\n\nfunc misuse() error {\n\tvalue()!\n\treturn nil\n}\n'
        );
      }
      const done = taskDone('gon-check');
      try {
        const execution = await vscode.commands.executeCommand<vscode.TaskExecution>('gon.checkProject', modernUri);
        assert.ok(execution, 'Check Project should start a task');
        const check = execution.task.execution as vscode.ProcessExecution;
        assert.ok(check.process.endsWith('/gon'), check.process);
        assert.deepEqual(check.args, ['check', './...']);
        assert.equal(await done.promise, expected, 'gon check exit status');
      } finally {
        done.dispose();
      }
    }
    await until(
      async () =>
        vscode.languages
          .getDiagnostics(brokenUri)
          .some((d) => d.source === 'gon check' && JSON.stringify(d.code).includes('InvalidErrorHandling'))
          ? true
          : undefined,
      'gon check problems for a file that is not open'
    );
    await fs.rm(brokenUri.fsPath);
    console.log('GON TEST: agent tooling capabilities and Check Project');
  }
  const baselineOutput = execFileSync(process.env.GO_ERROR_HANDLING_BASELINE!, ['run', legacyUri.fsPath, legacy], {
    cwd: legacy, encoding: 'utf8'
  });
  assert.equal(baselineOutput, '42 <nil> 0 wrapped: failure\n', 'legacy baseline and Gon retain equal behavior');
  assert.ok(
    execFileSync(process.env.GO_ERROR_HANDLING_BASELINE!, ['version'], { encoding: 'utf8' }).startsWith('go version')
  );
  console.log(
    'PASS: zero-config Gon selection and tool discovery, per-folder overrides, LSP, legacy/modern/baseline execution, run, debugger, test explorer'
  );
}

export async function run() {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      integration(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Integration suite exceeded 300 seconds')), 300000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

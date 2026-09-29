import type { GonTesting } from '../src/gon/testing';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { probeCapabilities, ToolingProbe } from '../src/gon/agentTooling';

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
  const temporary = process.env.GON_TEST_ROOT!;
  const modern = path.join(temporary, 'gon project & spaces');
  const legacy = path.join(temporary, 'go project');
  const modernUri = vscode.Uri.file(path.join(modern, 'main.go'));
  const legacyUri = vscode.Uri.file(path.join(legacy, 'main.go'));
  const extension = vscode.extensions.getExtension('gon-lang.gon');
  assert.ok(extension, 'Gon extension must be registered independently');
  await extension.activate();
  console.log('GON TEST: activated');
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
  assert.equal(legacyDocument.languageId, 'go', 'official Go project must keep Go language');
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
    }, 'official gopls hover in legacy project');
    console.log('GON TEST: Gon extension provides official gopls for Go');
  }
  console.log('GON TEST: language isolation');
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
    [legacyUri, 'gopls']
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
    assert.ok(result.passed.includes('TestOK'));
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
  // containing spaces and shell metacharacters, for both toolchains.
  for (const [uri, folder, command] of [
    [modernUri, modern, 'gon'],
    [legacyUri, legacy, 'go']
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
    // Projects that did not opt into Gon are not checked with Gon.
    assert.equal(await vscode.commands.executeCommand('gon.checkProject', legacyUri), undefined);
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
  assert.ok(
    execFileSync(process.env.GO_ERROR_HANDLING_BASELINE!, ['version'], { encoding: 'utf8' }).startsWith('go version')
  );
  assert.equal(vscode.workspace.getConfiguration('gon', legacyUri).get('enabled'), false);
  await vscode.window.showTextDocument(modernDocument);
  await vscode.commands.executeCommand('gon.disableWorkspace');
  await until(
    async () =>
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === modernUri.toString() && d.languageId === 'go'),
    'disable restores Go'
  );
  await vscode.commands.executeCommand('gon.enableWorkspace');
  await until(
    async () =>
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === modernUri.toString() && d.languageId === 'gon'),
    'enable restores Gon'
  );
  console.log(
    'PASS: VS Code Go/Gon isolation, LSP, run, debugger breakpoints/locals/step, test discovery/run/debug/fail/skip/subtests/cancel'
  );
}

export async function run() {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      integration(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Integration suite exceeded 120 seconds')), 300000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

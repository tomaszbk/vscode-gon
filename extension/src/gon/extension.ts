import { registerDebug } from './debug';
import { GonTesting } from './testing';
import { probeCapabilities, ToolingProbe } from './agentTooling';
// Copyright 2026 The Gon Authors. Licensed under the MIT license.
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  StaticFeature,
  DynamicFeature
} from 'vscode-languageclient/node';

const clients = new Map<string, LanguageClient>();
const autoSelected = new Set<string>();
let output: vscode.LogOutputChannel;
let serial: Promise<unknown> = Promise.resolve();
let shuttingDown = false;
let extensionContext: vscode.ExtensionContext;
const registeredCommands = new Set<string>();
const tooling = new Map<string, Promise<ToolingProbe>>();

class GonClient extends LanguageClient {
  override registerFeature(feature: StaticFeature | DynamicFeature<unknown>) {
    // VS Code command IDs are global, even with per-folder clients. Dispatch
    // server commands once below instead of registering duplicates per client.
    if ('registrationType' in feature && feature.registrationType.method === 'workspace/executeCommand') {
      return;
    }
    super.registerFeature(feature);
  }
}

function commandUri(value: unknown): vscode.Uri | undefined {
  if (typeof value === 'string' && value.startsWith('file:')) {
    return vscode.Uri.parse(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      const uri = commandUri(child);
      if (uri) {
        return uri;
      }
    }
  }
  return undefined;
}

function registerServerCommands(client: LanguageClient, language: 'go' | 'gon') {
  for (const command of client.initializeResult?.capabilities.executeCommandProvider?.commands ?? []) {
    if (!command.startsWith(language === 'gon' ? 'gonpls.' : 'gopls.')) {
      throw new Error('Language server command namespace does not match the selected toolchain.');
    }
    if (registeredCommands.has(command)) {
      continue;
    }
    registeredCommands.add(command);
    extensionContext.subscriptions.push(
      vscode.commands.registerCommand(command, (...args: unknown[]) => {
        const uri = commandUri(args) ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          throw new Error('Open a Gon document before running a server command.');
        }
        const key =
          vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() ??
          vscode.Uri.file(path.dirname(uri.fsPath)).toString();
        const owner = clients.get(`${key}|${language}`);
        if (!owner) {
          throw new Error('Open a document for the toolchain that provides this command.');
        }
        return owner.sendRequest('workspace/executeCommand', { command, arguments: args });
      })
    );
  }
}

function config(uri?: vscode.Uri) {
  return vscode.workspace.getConfiguration('gon', uri);
}

function isGoFile(document: vscode.TextDocument) {
  return document.uri.scheme === 'file' && document.uri.fsPath.endsWith('.go');
}

function isGon(document: vscode.TextDocument) {
  return document.languageId === 'gon' || config(document.uri).get<boolean>('enabled', false);
}

function tool(setting: string, fallback: string, uri: vscode.Uri): string {
  let value = config(uri).get<string>(setting, fallback).trim();
  if (!value) {
    value = fallback;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (value.includes('${workspaceFolder}')) {
    if (!folder) {
      throw new Error(`${setting} uses \${workspaceFolder}, but this file has no workspace folder.`);
    }
    value = value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  // Bare executable names are resolved through PATH. Relative paths belong
  // to the project, not to the extension host's working directory.
  if (!path.isAbsolute(value) && /[/\\]/.test(value)) {
    value = path.resolve(folder?.uri.fsPath ?? path.dirname(uri.fsPath), value);
  }
  return value;
}

function enqueue(work: () => Promise<unknown>): Promise<unknown> {
  const next = serial.then(work);
  serial = next.catch(report);
  return next;
}

function report(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(message);
  void vscode.window.showErrorMessage(`Gon: ${message}`);
}

export async function getToolingCapabilities(uri: vscode.Uri): Promise<ToolingProbe> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running its tools.');
  }
  const directory = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
  const executable = tool('compilerPath', 'gon', uri);
  const key = JSON.stringify([directory, executable]);
  let pending = tooling.get(key);
  if (!pending) {
    pending = probeCapabilities(executable, directory);
    tooling.set(key, pending);
  }
  return pending;
}

async function selectedGonProject(uri?: vscode.Uri): Promise<vscode.WorkspaceFolder> {
  uri ??= vscode.window.activeTextEditor?.document.uri;
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? (await vscode.window.showWorkspaceFolderPick());
  if (!folder || !config(folder.uri).get<boolean>('enabled', false)) {
    throw new Error('Select a project with Gon enabled to use agent tooling.');
  }
  return folder;
}

export async function checkProject(uri?: vscode.Uri): Promise<vscode.TaskExecution> {
  const folder = await selectedGonProject(uri);
  const probe = await getToolingCapabilities(folder.uri);
  if (!probe.available) {
    throw new Error(probe.reason);
  }
  if (!probe.result.capabilities.check) {
    throw new Error('The selected Gon toolchain does not support gon check. Update it to use Check Project.');
  }
  const task = new vscode.Task(
    { type: 'gon-check' },
    folder,
    'Gon: Check Project (saved files)',
    'Gon',
    new vscode.ProcessExecution(tool('compilerPath', 'gon', folder.uri), ['check', './...'], { cwd: folder.uri.fsPath }),
    // Also reports files that are not open, alongside gonpls diagnostics.
    ['$gon-check']
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  return vscode.tasks.executeTask(task);
}

async function startClient(document: vscode.TextDocument) {
  if (shuttingDown || !vscode.workspace.isTrusted) {
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const directory = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
  const language = document.languageId === 'gon' ? 'gon' : 'go';
  if (language === 'go' && vscode.extensions.getExtension('golang.go')?.isActive) {
    output.appendLine(
      'The official Go extension is active. Disable it in this workspace to let Gon provide Go language features.'
    );
    return;
  }
  const key = `${folder?.uri.toString() ?? vscode.Uri.file(directory).toString()}|${language}`;
  if (clients.has(key)) {
    return;
  }
  const settings = config(document.uri).get<Record<string, unknown>>(
    language === 'gon' ? 'serverSettings' : 'goServerSettings',
    {}
  );
  let serverPath = tool(
    language === 'gon' ? 'languageServerPath' : 'goLanguageServerPath',
    language === 'gon' ? 'gonpls' : 'gopls',
    document.uri
  );
  const serverEnv = { ...process.env };
  if (language === 'gon') {
    const probe = await getToolingCapabilities(document.uri);
    if (probe.available) {
      // An unconfigured server follows the selected compiler, including when
      // each folder selects a different installation. Explicit overrides win.
      if (serverPath === 'gonpls') {
        serverPath = probe.result.toolchain.languageServer;
      }
      output.appendLine(`Gon tooling schema ${probe.result.schemaVersion} for ${directory}`);
    } else {
      // Older tools still provide ordinary LSP features. New CLI integrations
      // explain the missing capability when the user invokes them.
      output.appendLine(`${directory}: ${probe.reason}`);
    }
  }
  // Go installers commonly put gopls in GOBIN/GOPATH/bin, outside PATH.
  // Resolve it without installing or overwriting any user tools.
  if (language === 'go') {
    try {
      const result = await promisify(execFile)(
        tool('goPath', 'go', document.uri),
        ['env', '-json', 'GOBIN', 'GOPATH', 'GOROOT'],
        { cwd: directory }
      );
      const env = JSON.parse(result.stdout) as { GOBIN: string; GOPATH: string; GOROOT: string };
      serverEnv.GOROOT = env.GOROOT;
      serverEnv.PATH = path.join(env.GOROOT, 'bin') + path.delimiter + (process.env.PATH ?? '');
      if (serverPath === 'gopls') {
        const candidate = path.join(
          env.GOBIN || path.join(env.GOPATH.split(path.delimiter)[0], 'bin'),
          process.platform === 'win32' ? 'gopls.exe' : 'gopls'
        );
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
          serverPath = candidate;
        } catch {
          /* Fall back to PATH. */
        }
      }
    } catch (error) {
      throw new Error(`Cannot query the selected Go toolchain: ${error}`);
    }
  }
  const serverOptions: ServerOptions = {
    command: serverPath,
    args: ['serve'],
    options: { cwd: directory, env: serverEnv }
  };
  const options: LanguageClientOptions = {
    // A separate client per project prevents Go/Gon or different Gon
    // toolchains from sharing one server instance in multi-root workspaces.
    documentSelector: [
      { scheme: 'file', language, pattern: { baseUri: vscode.Uri.file(directory).toString(), pattern: '**/*.go' } }
    ],
    workspaceFolder: folder ?? { uri: vscode.Uri.file(directory), name: path.basename(directory), index: 0 },
    outputChannel: output,
    traceOutputChannel: output,
    initializationOptions: settings,
    middleware: {
      workspace: {
        configuration: async (params) => params.items.map(() => settings)
      }
    }
  };
  const client = new GonClient(
    `gon-${key}`,
    `${language === 'gon' ? 'Gon' : 'Go'} (${path.basename(directory)})`,
    serverOptions,
    options
  );
  clients.set(key, client);
  try {
    await client.start();
    registerServerCommands(client, language);
    output.appendLine(`${language === 'gon' ? 'gonpls' : 'gopls'} ready for ${directory}`);
  } catch (error) {
    clients.delete(key);
    await client.stop();
    throw new Error(
      `Could not start ${language === 'gon' ? 'gonpls' : 'gopls'}. Check the selected tools in Gon settings. ${error}`
    );
  }
}

async function reconcileDocument(document: vscode.TextDocument) {
  if (shuttingDown || document.isClosed || !isGoFile(document) || !vscode.workspace.isTrusted) {
    return;
  }
  if (config(document.uri).get<boolean>('enabled', false) && document.languageId === 'go') {
    autoSelected.add(document.uri.toString());
    document = await vscode.languages.setTextDocumentLanguage(document, 'gon');
  } else if (
    !config(document.uri).get<boolean>('enabled', false) &&
    autoSelected.delete(document.uri.toString()) &&
    document.languageId === 'gon'
  ) {
    document = await vscode.languages.setTextDocumentLanguage(document, 'go');
  }
  if (document.languageId === 'gon' || document.languageId === 'go') {
    await startClient(document);
  }
}

async function stopClients() {
  const current = [...clients.values()];
  clients.clear();
  await Promise.all(current.map((c) => c.stop()));
}

async function restart() {
  await stopClients();
  tooling.clear();
  for (const document of vscode.workspace.textDocuments) {
    await reconcileDocument(document);
  }
}

async function selectProject(enabled: boolean) {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  let selected = folder;
  if (!selected) {
    selected = await vscode.window.showWorkspaceFolderPick();
  }
  if (!selected) {
    return;
  }
  await config(selected.uri).update('enabled', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
  if (!enabled) {
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.languageId === 'gon' &&
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === selected.uri.toString()
      ) {
        await vscode.languages.setTextDocumentLanguage(document, 'go');
      }
    }
  }
  await enqueue(restart);
}

export async function runFile(uri?: vscode.Uri): Promise<vscode.TaskExecution | undefined> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running code.');
  }
  const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!document || !isGoFile(document)) {
    throw new Error('Open a saved .go file to run it.');
  }
  if (document.fileName.endsWith('_test.go')) {
    throw new Error('Test files must be run with gon test or go test.');
  }
  if (document.isDirty && !(await document.save())) {
    throw new Error('The file could not be saved; nothing was executed.');
  }
  const gon = isGon(document);
  const executable = tool(gon ? 'compilerPath' : 'goPath', gon ? 'gon' : 'go', document.uri);
  const args = config(document.uri).get<string[]>('run.args', []);
  const target = config(document.uri).get<string>('run.mode', 'file') === 'package' ? '.' : document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const name = `${gon ? 'Gon' : 'Go'}: Run ${path.basename(document.uri.fsPath)}`;
  const task = new vscode.Task(
    { type: 'gon-run', file: document.uri.toString() },
    folder ?? vscode.TaskScope.Global,
    name,
    'Gon',
    new vscode.ProcessExecution(executable, ['run', target, ...args], { cwd: path.dirname(document.uri.fsPath) }),
    ['$go']
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true
  };
  // ProcessExecution passes arguments directly, including filenames and
  // arguments with spaces or shell metacharacters. No shell string is built.
  return vscode.tasks.executeTask(task);
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Gon', { log: true });
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('gon.runFile', async (uri?: vscode.Uri) => {
      try {
        return await runFile(uri);
      } catch (error) {
        report(error);
        return undefined;
      }
    }),
    vscode.commands.registerCommand('gon.enableWorkspace', () => selectProject(true)),
    vscode.commands.registerCommand('gon.disableWorkspace', () => selectProject(false)),
    vscode.commands.registerCommand('gon.restartLanguageServer', () => enqueue(restart)),
    vscode.commands.registerCommand('gon.checkProject', async (uri?: vscode.Uri) => {
      try {
        return await checkProject(uri);
      } catch (error) {
        report(error);
        return undefined;
      }
    }),
    vscode.commands.registerCommand('gon.showToolingCapabilities', async (uri?: vscode.Uri) => {
      try {
        const folder = await selectedGonProject(uri);
        const probe = await getToolingCapabilities(folder.uri);
        output.appendLine(`${folder.uri.fsPath}: ${JSON.stringify(probe, null, 2)}`);
        output.show();
        if (!probe.available) {
          throw new Error(probe.reason);
        }
        return probe.result;
      } catch (error) {
        report(error);
        return undefined;
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      void enqueue(() => reconcileDocument(doc)).catch(() => {});
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        [
          'gon.enabled',
          'gon.compilerPath',
          'gon.languageServerPath',
          'gon.serverSettings',
          'gon.goLanguageServerPath',
          'gon.goServerSettings',
          'gon.goPath'
        ].some((key) => event.affectsConfiguration(key))
      ) {
        void enqueue(restart).catch(() => {});
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void enqueue(restart).catch(() => {});
    })
  );
  registerDebug(context, output);
  const testing = new GonTesting(output, context);
  await enqueue(async () => {
    for (const document of vscode.workspace.textDocuments) {
      await reconcileDocument(document);
    }
  });
  return { testing, getToolingCapabilities };
}

export async function deactivate() {
  shuttingDown = true;
  await serial;
  await stopClients();
}

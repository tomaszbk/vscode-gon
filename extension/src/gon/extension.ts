import { registerDebug } from './debug';
import { GonTesting } from './testing';
import { config, tool } from './toolchain';
import { probeCapabilities, ToolingProbe } from './agentTooling';
// Copyright 2026 The Gon Authors. Licensed under the MIT license.
import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  StaticFeature,
  DynamicFeature
} from 'vscode-languageclient/node';

const clients = new Map<string, LanguageClient>();
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
    // Gon settings are snapshots passed at initialization and workspace/configuration.
    // Our serialized configuration listener restarts affected clients. The generic
    // client's listener also sends on unrelated changes and can auto-start a client
    // while that restart is stopping it, producing a spurious start failure.
    if ('registrationType' in feature && feature.registrationType.method === 'workspace/didChangeConfiguration') {
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

function registerServerCommands(client: LanguageClient, language: 'gon') {
  for (const command of client.initializeResult?.capabilities.executeCommandProvider?.commands ?? []) {
    if (!command.startsWith('gonpls.')) {
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

function isGoFile(document: vscode.TextDocument) {
  return document.uri.scheme === 'file' && document.uri.fsPath.endsWith('.go');
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
  if (!folder) {
    throw new Error('Open a project folder to use Gon agent tooling.');
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
    new vscode.ProcessExecution(
      tool('compilerPath', 'gon', folder.uri),
      [
        'check',
        './...',
        ...(config(folder.uri).get<Record<string, unknown>>('serverSettings', {}).nilaway === true ? ['--nilaway'] : [])
      ],
      { cwd: folder.uri.fsPath }
    ),
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
  const language = 'gon';
  const key = `${folder?.uri.toString() ?? vscode.Uri.file(directory).toString()}|${language}`;
  if (clients.has(key)) {
    return;
  }
  const settings = config(document.uri).get<Record<string, unknown>>('serverSettings', {});
  let serverPath = tool('languageServerPath', 'gonpls', document.uri);
  const serverEnv = { ...process.env };
  const probe = await getToolingCapabilities(document.uri);
  if (probe.available) {
    // The default server follows the selected compiler. Explicit paths win.
    if ((config(document.uri).get<string>('languageServerPath', 'gonpls').trim() || 'gonpls') === 'gonpls') {
      serverPath = probe.result.toolchain.languageServer;
    }
    output.appendLine(`Gon tooling schema ${probe.result.schemaVersion} for ${directory}`);
  } else {
    // Older tools still provide LSP; CLI integrations explain missing features.
    output.appendLine(`${directory}: ${probe.reason}`);
  }
  const serverOptions: ServerOptions = {
    command: serverPath,
    args: ['serve'],
    options: { cwd: directory, env: serverEnv }
  };
  const options: LanguageClientOptions = {
    // Each project has its own server, including when tool paths are overridden.
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
    `Gon (${path.basename(directory)})`,
    serverOptions,
    options
  );
  clients.set(key, client);
  try {
    await client.start();
    registerServerCommands(client, language);
    output.appendLine(`gonpls ready for ${directory}`);
  } catch (error) {
    clients.delete(key);
    await client.stop();
    throw new Error(
      `Could not start gonpls. Install the Gon toolchain, then restart VS Code. ${error}`
    );
  }
}

async function reconcileDocument(document: vscode.TextDocument) {
  if (shuttingDown || document.isClosed || !isGoFile(document) || !vscode.workspace.isTrusted) {
    return;
  }
  if (document.languageId === 'go') {
    document = await vscode.languages.setTextDocumentLanguage(document, 'gon');
  }
  if (document.languageId === 'gon') {
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

export async function runFile(uri?: vscode.Uri): Promise<vscode.TaskExecution | undefined> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running code.');
  }
  const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!document || !isGoFile(document)) {
    throw new Error('Open a saved .go file to run it.');
  }
  if (document.fileName.endsWith('_test.go')) {
    throw new Error('Test files must be run with gon test.');
  }
  if (document.isDirty && !(await document.save())) {
    throw new Error('The file could not be saved; nothing was executed.');
  }
  const executable = tool('compilerPath', 'gon', document.uri);
  const args = config(document.uri).get<string[]>('run.args', []);
  const target = config(document.uri).get<string>('run.mode', 'file') === 'package' ? '.' : document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const name = `Gon: Run ${path.basename(document.uri.fsPath)}`;
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
          'gon.compilerPath',
          'gon.languageServerPath',
          'gon.serverSettings'
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

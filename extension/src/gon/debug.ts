import { realpath } from 'fs/promises';
// Native Delve DAP integration, following the upstream Go extension's server model.
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { environment, tool, terminate } from './toolchain';

export function registerDebug(context: vscode.ExtensionContext, output: vscode.LogOutputChannel) {
  const processes = new Map<string, ChildProcess>();
  const provider: vscode.DebugConfigurationProvider = {
    resolveDebugConfiguration(folder, configuration) {
      const c = { ...configuration };
      if (!c.type) {
        c.type = 'gon';
        c.name = 'Launch Go/Gon package';
        c.request = 'launch';
        c.mode = 'debug';
      }
      if (!c.program && c.request === 'launch') {
        c.program = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '');
      }
      if (c.mode === 'auto' || !c.mode) {
        c.mode =
          c.request === 'attach'
            ? 'local'
            : vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('_test.go')
              ? 'test'
              : 'debug';
      }
      if (!c.cwd) {
        c.cwd = folder?.uri.fsPath ?? (c.program ? path.dirname(c.program) : undefined);
      }
      if (!vscode.workspace.isTrusted) {
        throw new Error('Trust this workspace before debugging.');
      }
      c.outputMode ??= 'remote';
      return c;
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, c) {
      // Go module resolution compares physical paths. On macOS /var and
      // /tmp are symlinks; passing their spelling to go build can appear
      // outside the module even when cwd refers to the same directory.
      if (c.port) {
        return c;
      }
      const base = folder?.uri.fsPath ?? process.cwd();
      if (c.cwd) {
        c.cwd = await realpath(path.resolve(base, c.cwd));
      }
      if (c.program) {
        c.program = await realpath(path.resolve(base, c.program));
      }
      if (folder) {
        const physical = await realpath(folder.uri.fsPath);
        if (physical !== folder.uri.fsPath) {
          c.substitutePath = [...(c.substitutePath ?? []), { from: folder.uri.fsPath, to: physical }];
        }
      }
      return c;
    }
  };
  const factory: vscode.DebugAdapterDescriptorFactory = {
    async createDebugAdapterDescriptor(session) {
      const c = session.configuration;
      if (c.port) {
        return new vscode.DebugAdapterServer(c.port, c.host ?? '127.0.0.1');
      }
      const uri = session.workspaceFolder?.uri ?? vscode.Uri.file(c.cwd ?? path.dirname(c.program));
      const cwd = c.cwd ?? uri.fsPath;
      const { env, values } = await environment(uri, cwd);
      let dlv = tool('debuggerPath', 'dlv', uri);
      if (dlv === 'dlv') {
        const candidate = path.join(
          values.GOBIN || path.join(values.GOPATH.split(path.delimiter)[0], 'bin'),
          process.platform === 'win32' ? 'dlv.exe' : 'dlv'
        );
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
          dlv = candidate;
        } catch {
          /* PATH fallback */
        }
      }
      // Delve invokes "go" internally. This environment points only this debug
      // session at the selected compiler; the user's PATH remains untouched.
      const child = spawn(dlv, ['dap', '--listen=127.0.0.1:0', ...(c.dlvFlags ?? [])], {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      processes.set(session.id, child);
      child.stderr.on('data', (data: Buffer) => output.append(data.toString()));
      return new Promise<vscode.DebugAdapterServer>((resolve, reject) => {
        let text = '';
        let connected = false;
        const timer = setTimeout(() => {
          terminate(child);
          reject(new Error('Timed out starting Delve DAP. See Gon output.'));
        }, 15000);
        child.stdout.on('data', (data: Buffer) => {
          output.append(data.toString());
          if (connected) {
            return;
          }
          text += data.toString();
          const match = text.match(/DAP server listening at: (?:127\.0\.0\.1|\[::\]):(\d+)/);
          if (match) {
            connected = true;
            text = '';
            clearTimeout(timer);
            resolve(new vscode.DebugAdapterServer(Number(match[1]), '127.0.0.1'));
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          processes.delete(session.id);
          reject(new Error(`Cannot start Delve (${dlv}): ${error.message}`));
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          processes.delete(session.id);
          reject(new Error(`Delve exited (${code}). See Gon output.`));
        });
      });
    }
  };
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        if (!['gon', 'go'].includes(session.type)) {
          return;
        }
        return {
          onDidSendMessage(message: any) {
            if (message.type === 'event' || message.success === false) {
              output.debug('DAP: ' + JSON.stringify(message));
            }
          }
        };
      }
    })
  );
  for (const type of ['gon', 'go']) {
    if (type === 'go' && vscode.extensions.getExtension('golang.go')?.isActive) {
      continue;
    }
    context.subscriptions.push(
      vscode.debug.registerDebugConfigurationProvider(type, provider),
      vscode.debug.registerDebugAdapterDescriptorFactory(type, factory)
    );
  }
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      const child = processes.get(session.id);
      if (child) {
        terminate(child);
        processes.delete(session.id);
      }
    }),
    {
      dispose() {
        for (const child of processes.values()) {
          terminate(child);
        }
        processes.clear();
      }
    }
  );
}

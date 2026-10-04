import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { accessSync, constants, statSync } from 'fs';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

export function config(uri?: vscode.Uri) {
  return vscode.workspace.getConfiguration('gon', uri);
}
export function tool(setting: string, fallback: string, uri: vscode.Uri): string {
  let value = config(uri).get<string>(setting, fallback).trim() || fallback;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (value.includes('${workspaceFolder}')) {
    if (!folder) {
      throw new Error(`${setting} requires a workspace folder.`);
    }
    value = value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  if (!path.isAbsolute(value) && /[/\\]/.test(value)) {
    value = path.resolve(folder?.uri.fsPath ?? path.dirname(uri.fsPath), value);
  }
  // GUI editors can inherit an older PATH. Also find the installer's default
  // public directory without exposing the toolchain's private go executable.
  if (value === fallback && (fallback === 'gon' || fallback === 'gonpls')) {
    return findPublicTool(fallback, process.env.PATH ?? '', os.homedir()) ?? value;
  }
  return value;
}
// Keep discovery independent of editor configuration so all consumers use
// the same PATH-first policy, with a fallback for GUI editors' older environments.
export function findPublicTool(name: string, searchPath: string, home: string): string | undefined {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directories = [...searchPath.split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin')];
  for (const directory of directories) {
    const candidate = path.join(directory, name + suffix);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      /* Try the next public directory. */
    }
  }
  return undefined;
}
export function compiler(uri: vscode.Uri) {
  return tool('compilerPath', 'gon', uri);
}
export async function environment(uri: vscode.Uri, cwd: string) {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running its tools.');
  }
  const result = await promisify(execFile)(compiler(uri), ['env', '-json', 'GOROOT', 'GOPATH', 'GOBIN'], { cwd });
  const values = JSON.parse(result.stdout) as { GOROOT: string; GOPATH: string; GOBIN: string };
  return {
    values,
    env: {
      ...process.env,
      GOROOT: values.GOROOT,
      GOTOOLCHAIN: 'local',
      PATH: path.join(values.GOROOT, 'bin') + path.delimiter + (process.env.PATH ?? '')
    }
  };
}
export function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGINT');
    } catch {
      child.kill('SIGINT');
    }
  } else if (child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    });
  }
}
export async function runTool(
  command: string,
  args: string[],
  cwd: string,
  token: vscode.CancellationToken,
  onLine: (line: string) => void,
  env = process.env
): Promise<number> {
  if (token.isCancellationRequested) {
    return -1;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      pending += data;
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        onLine(line);
      }
    });
    child.stderr.on('data', (data: Buffer) => onLine(data.toString()));
    const cancel = token.onCancellationRequested(() => terminate(child));
    child.once('error', (err) => {
      cancel.dispose();
      reject(err);
    });
    child.once('close', (code) => {
      cancel.dispose();
      if (pending) {
        onLine(pending);
      }
      resolve(code ?? -1);
    });
  });
}

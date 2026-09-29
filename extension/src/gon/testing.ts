import * as vscode from 'vscode';
import { compiler, config, environment, runTool } from './toolchain';

type Entry = { folder: vscode.WorkspaceFolder; pkg: string; dir: string; name?: string };
type TestEvent = { Action: string; Package?: string; Test?: string; Output?: string; Elapsed?: number };
export type RunSummary = { passed: string[]; failed: string[]; skipped: string[]; cancelled: boolean };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = (s: string) =>
  s
    .split('/')
    .map((p) => '^' + escape(p) + '$')
    .join('/');

export class GonTesting implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('gon.tests', 'Go / Gon');
  private entries = new WeakMap<vscode.TestItem, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private running = 0;
  private refreshPending = false;
  private active = new Set<vscode.CancellationTokenSource>();
  private timer?: NodeJS.Timeout;
  constructor(
    private output: vscode.LogOutputChannel,
    context: vscode.ExtensionContext
  ) {
    this.controller.resolveHandler = () => this.refresh();
    this.controller.refreshHandler = (token) => this.refresh(token);
    this.controller.createRunProfile(
      'Run Go/Gon Tests',
      vscode.TestRunProfileKind.Run,
      (r, t) => this.run(r, t).then(() => {}),
      true
    );
    this.controller.createRunProfile(
      'Debug Go/Gon Tests',
      vscode.TestRunProfileKind.Debug,
      (r, t) => this.run(r, t, true).then(() => {}),
      true
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{go,mod,work}');
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.refresh();
      }, 750);
    };
    context.subscriptions.push(
      this,
      watcher,
      watcher.onDidCreate(changed),
      watcher.onDidChange(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeWorkspaceFolders(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gon')) {
          changed();
        }
      })
    );
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const c of this.active) {
      c.cancel();
    }
    this.controller.dispose();
  }
  refresh(token?: vscode.CancellationToken) {
    this.queue = this.queue.then(() => this.discover(token)).catch((e) => this.output.error(String(e)));
    return this.queue;
  }
  private async discover(token?: vscode.CancellationToken) {
    if (this.disposed || !vscode.workspace.isTrusted) {
      return;
    }
    if (this.running) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    const c = new vscode.CancellationTokenSource();
    this.active.add(c);
    const sub = token?.onCancellationRequested(() => c.cancel());
    if (token?.isCancellationRequested) {
      c.cancel();
    }
    try {
      const roots: vscode.TestItem[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (c.token.isCancellationRequested) {
          break;
        }
        const root = this.controller.createTestItem(folder.uri.toString(), folder.name, folder.uri);
        roots.push(root);
        root.busy = true;
        try {
          const { env } = await environment(folder.uri, folder.uri.fsPath);
          const flags = config(folder.uri).get<string[]>('test.buildFlags', []);
          const patterns = config(folder.uri).get<string[]>('test.packagePatterns', ['./...']);
          const dirs = new Map<string, string>();
          let errors = '';
          const code = await runTool(
            compiler(folder.uri),
            ['list', ...flags, '-f', '{{.ImportPath}}\t{{.Dir}}', ...patterns],
            folder.uri.fsPath,
            c.token,
            (line) => {
              const p = line.split('\t');
              if (p.length === 2) {
                dirs.set(p[0], p[1]);
              } else {
                errors += line + '\n';
              }
            },
            env
          );
          if (code !== 0) {
            throw new Error(errors || 'Package discovery failed');
          }
          const packages = new Map<string, vscode.TestItem>();
          const testCode = await runTool(
            compiler(folder.uri),
            ['test', ...flags, '-list', '.', '-json', ...patterns],
            folder.uri.fsPath,
            c.token,
            (line) => {
              let e: TestEvent;
              try {
                e = JSON.parse(line);
              } catch {
                errors += line + '\n';
                return;
              }
              if (e.Action !== 'output' || !e.Output || !e.Package) {
                return;
              }
              const name = e.Output.trim(),
                dir = dirs.get(e.Package);
              if (!/^(Test|Example|Fuzz|Benchmark)\S*$/.test(name) || !dir) {
                errors += e.Output;
                return;
              }
              let pkg = packages.get(e.Package);
              if (!pkg) {
                pkg = this.controller.createTestItem(root.id + '#' + e.Package, e.Package, vscode.Uri.file(dir));
                packages.set(e.Package, pkg);
                root.children.add(pkg);
                this.entries.set(pkg, { folder, pkg: e.Package, dir });
              }
              const item = this.controller.createTestItem(pkg.id + '/' + name, name, vscode.Uri.file(dir));
              pkg.children.add(item);
              this.entries.set(item, { folder, pkg: e.Package, dir, name });
            },
            env
          );
          if (testCode !== 0 && !c.token.isCancellationRequested) {
            root.error = errors || 'Test discovery failed';
          }
          for (const pkg of packages.values()) {
            const files = await vscode.workspace.findFiles(new vscode.RelativePattern(pkg.uri!.fsPath, '*_test.go'));
            for (const uri of files) {
              const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();
              pkg.children.forEach((item) => {
                const match = new RegExp('^func\\s+' + escape(item.label) + '\\s*\\(', 'm').exec(content);
                if (match) {
                  const located = this.controller.createTestItem(item.id, item.label, uri);
                  const n = content.slice(0, match.index).split('\n').length - 1;
                  located.range = new vscode.Range(n, 0, n, 0);
                  this.entries.set(located, this.entries.get(item)!);
                  pkg.children.add(located);
                }
              });
            }
          }
        } catch (e) {
          root.error = String(e);
        } finally {
          root.busy = false;
        }
      }
      if (!this.disposed && !c.token.isCancellationRequested) {
        this.controller.items.replace(roots);
      }
    } finally {
      sub?.dispose();
      this.active.delete(c);
      c.dispose();
    }
  }
  async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug = false): Promise<RunSummary> {
    const summary: RunSummary = { passed: [], failed: [], skipped: [], cancelled: false };
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before running tests.');
    }
    if (!(await vscode.workspace.saveAll(false))) {
      throw new Error('Save source files before running tests.');
    }
    const run = this.controller.createTestRun(request),
      c = new vscode.CancellationTokenSource();
    this.active.add(c);
    this.running++;
    const sub = token.onCancellationRequested(() => c.cancel());
    if (token.isCancellationRequested) {
      c.cancel();
    }
    const selected: vscode.TestItem[] = [];
    const collect = (item: vscode.TestItem) => {
      if (request.exclude?.some((e) => e === item || item.id.startsWith(e.id + '/'))) {
        return;
      }
      if (this.entries.get(item)?.name && !request.exclude?.some((e) => e.id.startsWith(item.id + '/'))) {
        selected.push(item);
      } else {
        item.children.forEach(collect);
      }
    };
    if (request.include) {
      request.include.forEach(collect);
    } else {
      this.controller.items.forEach(collect);
    }
    const unique = selected.filter((i) => !selected.some((p) => p !== i && i.id.startsWith(p.id + '/')));
    unique.forEach((i) => run.enqueued(i));
    // Run top-level selections together so TestMain and package fixtures run
    // once. Nested selections keep their exact slash-separated Go regexp.
    const groups = new Map<string, vscode.TestItem[]>();
    const completed = new Set<vscode.TestItem>();
    for (const item of unique) {
      const e = this.entries.get(item)!;
      const key =
        e.name!.includes('/') || e.name!.startsWith('Benchmark') ? item.id : e.folder.uri.toString() + '#' + e.pkg;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    try {
      for (const items of groups.values()) {
        if (c.token.isCancellationRequested) {
          break;
        }
        const entry = this.entries.get(items[0])!;
        let output = '';
        items.forEach((item) => run.started(item));
        const event = (e: TestEvent) => {
          const item = items.find((i) => {
            const name = this.entries.get(i)!.name!;
            return e.Test === name || e.Test?.startsWith(name + '/');
          });
          if (e.Output) {
            output += e.Output;
            run.appendOutput(e.Output.replace(/\r?\n/g, '\r\n'), undefined, item);
          }
          if (!e.Test || !item) {
            return;
          }
          const owner = this.entries.get(item)!;
          let target = item;
          if (e.Test !== owner.name) {
            for (const part of e.Test.slice(owner.name!.length + 1).split('/')) {
              let next = target.children.get(target.id + '/' + part);
              if (!next) {
                next = this.controller.createTestItem(target.id + '/' + part, part, item.uri);
                target.children.add(next);
                this.entries.set(next, { ...owner, name: this.entries.get(target)!.name + '/' + part });
              }
              target = next;
            }
          }
          if (e.Action === 'run') {
            run.started(target);
          }
          if (e.Action === 'pass') {
            run.passed(target, (e.Elapsed ?? 0) * 1000);
            summary.passed.push(e.Test);
          }
          if (e.Action === 'fail') {
            run.failed(target, new vscode.TestMessage(output || 'Test failed'), (e.Elapsed ?? 0) * 1000);
            summary.failed.push(e.Test);
          }
          if (e.Action === 'skip') {
            run.skipped(target);
            summary.skipped.push(e.Test);
          }
          if (target === item && ['pass', 'fail', 'skip'].includes(e.Action)) {
            completed.add(item);
          }
        };
        try {
          const benchmark = entry.name!.startsWith('Benchmark'),
            filter =
              items.length === 1
                ? pattern(entry.name!)
                : '^(' + items.map((i) => escape(this.entries.get(i)!.name!)).join('|') + ')$';
          const args = ['-count=1', '-run', benchmark ? '^$' : filter, ...(benchmark ? ['-bench', filter] : [])];
          const { env } = await environment(entry.folder.uri, entry.dir);
          const code = debug
            ? await this.debug(entry, args, c.token, event)
            : await runTool(
                compiler(entry.folder.uri),
                [
                  'test',
                  ...config(entry.folder.uri).get<string[]>('test.buildFlags', []),
                  '-json',
                  ...args,
                  '.',
                  ...config(entry.folder.uri).get<string[]>('test.args', [])
                ],
                entry.dir,
                c.token,
                (line) => {
                  try {
                    event(JSON.parse(line));
                  } catch {
                    event({ Action: 'output', Output: line + '\n' });
                  }
                },
                env
              );
          if (!c.token.isCancellationRequested) {
            for (const item of items) {
              if (completed.has(item)) {
                continue;
              }
              const name = this.entries.get(item)!.name!;
              if (code === 0 && benchmark) {
                run.passed(item);
                summary.passed.push(name);
              } else if (code === 0) {
                run.skipped(item);
                summary.skipped.push(name);
              } else {
                run.failed(item, new vscode.TestMessage(output || `Test process exited ${code}`));
                summary.failed.push(name);
              }
              completed.add(item);
            }
          }
        } catch (e) {
          for (const item of items) {
            run.errored(item, new vscode.TestMessage(String(e)));
            summary.failed.push(this.entries.get(item)!.name!);
            completed.add(item);
          }
        }
      }
    } finally {
      summary.cancelled = c.token.isCancellationRequested;
      if (summary.cancelled) {
        unique.forEach((i) => {
          if (!completed.has(i)) {
            run.skipped(i);
          }
        });
      }
      sub.dispose();
      this.active.delete(c);
      c.dispose();
      run.end();
      this.running--;
      if (!this.running && this.refreshPending) {
        void this.refresh();
      }
    }
    return summary;
  }
  private async debug(entry: Entry, args: string[], token: vscode.CancellationToken, event: (e: TestEvent) => void) {
    const id = `gon-test-${Date.now()}-${Math.random()}`;
    let session: vscode.DebugSession | undefined,
      exit = -1,
      pending = '';
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('gon', {
      createDebugAdapterTracker(s) {
        if (s.configuration.gonTestId !== id) {
          return;
        }
        session = s;
        return {
          onDidSendMessage(message: any) {
            if (message.event === 'exited') {
              exit = message.body.exitCode;
            }
            if (message.event === 'output') {
              const output = message.body.output as string;
              event({ Action: 'output', Output: output });
              pending += output;
              let n: number;
              while ((n = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, n).trim();
                pending = pending.slice(n + 1);
                const start = /^=== RUN\s+(\S+)/.exec(line),
                  done = /^--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/.exec(line);
                if (start) {
                  event({ Action: 'run', Test: start[1] });
                }
                if (done) {
                  event({ Action: done[1].toLowerCase(), Test: done[2], Elapsed: Number(done[3]) });
                }
              }
            }
          }
        };
      }
    });
    let ended: vscode.Disposable | undefined;
    const complete = new Promise<void>((resolve) => {
      ended = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.configuration.gonTestId === id) {
          resolve();
        }
      });
    });
    const cancel = token.onCancellationRequested(() => {
      if (session) {
        void vscode.debug.stopDebugging(session);
      }
    });
    try {
      const started = await vscode.debug.startDebugging(entry.folder, {
        type: 'gon',
        name: `Debug ${entry.name}`,
        request: 'launch',
        mode: 'test',
        program: entry.dir,
        cwd: entry.dir,
        gonTestId: id,
        buildFlags: config(entry.folder.uri).get<string[]>('test.buildFlags', []),
        args: ['-test.v', ...args.map((a) => (a.startsWith('-') ? '-test.' + a.slice(1) : a))]
      });
      if (!started) {
        throw new Error('Could not start the test debugger');
      }
      if (token.isCancellationRequested && session) {
        await vscode.debug.stopDebugging(session);
      }
      await complete;
      return exit;
    } finally {
      cancel.dispose();
      ended?.dispose();
      tracker.dispose();
    }
  }
}

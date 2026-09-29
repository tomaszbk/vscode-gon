import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  // The Codex/VS Code terminal may inherit Electron's CLI-only mode.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gon-vscode-'));
  const gonRoot = process.env.GON_ROOT;
  if (!gonRoot) {
    throw new Error('Set GON_ROOT to the built Gon toolchain directory');
  }
  const baseline = process.env.GO_ERROR_HANDLING_BASELINE;
  if (!baseline) {
    throw new Error('Set GO_ERROR_HANDLING_BASELINE to official Go');
  }
  const modern = path.join(temporary, 'gon project & spaces');
  const legacy = path.join(temporary, 'go project');
  const sibling = path.join(temporary, 'second gon project');
  const source = `package main
import (
 "errors"
 "fmt"
 "os"
 "path/filepath"
)
func read(fail bool) (int, error) {
 if fail { return 99, errors.New("failure") }
 return 21, nil
}
func twice(fail bool) (int, error) {
 value := read(fail) or problem { return 0, fmt.Errorf("wrapped: %w", problem) }
 next := read(false)!
 return value + next, nil
}
func main() {
 a, e := twice(false)
 b, f := twice(true)
 result := fmt.Sprintln(a, e, b, f)
 if err := os.WriteFile(filepath.Join(os.Args[1], "executed.txt"), []byte(result), 0600); err != nil { panic(err) }
 fmt.Print(result)
}
`;
  try {
    for (const [folder, enabled] of [
      [modern, true],
      [legacy, false],
      [sibling, true]
    ] as const) {
      await fs.mkdir(path.join(folder, '.vscode'), { recursive: true });
      const content = enabled
        ? source
        : source
            .replace('value := read(fail) or problem {', 'value, problem := read(fail)\n if problem != nil {')
            .replace('next := read(false)!', 'next, err := read(false)\n if err != nil { return 0, err }');
      await fs.writeFile(path.join(folder, 'main.go'), content);
      await fs.writeFile(
        path.join(folder, 'main_test.go'),
        `package main
import ("testing"; "time")
func TestOK(t *testing.T) { n,e:=twice(false); if n!=42 || e!=nil {t.Fatal(n,e)}; t.Run("nested",func(t *testing.T){t.Log("subtest output")}); t.Run("sibling",func(t *testing.T){}) }
func TestFailure(t *testing.T) {t.Fatal("intentional failure for explorer verification")}
func TestSkip(t *testing.T) {t.Skip("intentional skip")}
func TestSlow(t *testing.T) {time.Sleep(30*time.Second)}
`
      );
      await fs.writeFile(path.join(folder, 'go.mod'), 'module example.com/run\n\ngo 1.26\n');
      await fs.writeFile(
        path.join(folder, '.vscode', 'settings.json'),
        JSON.stringify({
          'gon.enabled': enabled,
          'gon.compilerPath': path.join(gonRoot, 'gon/bin/gon'),
          'gon.languageServerPath': path.join(gonRoot, 'gon/bin/gonpls'),
          'gon.goPath': baseline,
          'gon.goLanguageServerPath': process.env.GON_TEST_GOPLS ?? 'gopls',
          'gon.run.args': [folder],
          'gon.debuggerPath': process.env.GON_TEST_DLV ?? path.join(os.homedir(), 'go/bin/dlv'),
          'go.alternateTools': { go: baseline, gopls: process.env.GON_TEST_GOPLS ?? 'gopls' },
          'go.toolsManagement.autoUpdate': false,
          'go.toolsManagement.checkForUpdates': 'off',
          'go.terminal.activateEnvironment': false
        })
      );
    }
    const workspace = path.join(temporary, 'coexist.code-workspace');
    await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: modern }, { path: legacy }, { path: sibling }] }));
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir=' + path.join(temporary, 'profile'),
        '--extensions-dir=' + path.join(temporary, 'extensions')
      ],
      extensionTestsEnv: { GON_TEST_ROOT: temporary, GON_ROOT: gonRoot, GO_ERROR_HANDLING_BASELINE: baseline }
    });
  } catch (error) {
    await fs.cp(path.join(temporary, 'profile/logs'), '/tmp/vscode-gon-last-failure-logs', { recursive: true });
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

# Gon for Visual Studio Code

Go and Gon language support, derived from the official Go extension. This fork
has its own extension ID, `gon-lang.gon`. It can be your single extension for both
languages: disable the official `golang.go` extension in the workspace.

The Gon compiler and `gonpls` language server are maintained in the Gon toolchain
repository. This repository contains only the editor extension. It does not
install or replace Go, gopls, Gon, or gonpls automatically.

## Use

1. Install the Gon toolchain and expose its `gon` and `gonpls` commands.
2. Install this extension's VSIX (see Build below), disable **Go** (`golang.go`)
   in the workspace, and reload VS Code.
3. Open a project and run **Gon: Enable for This Project**, or add
   `"gon.enabled": true` to that folder's `.vscode/settings.json`.
4. Open a `.go` file. The editor language becomes **Gon** and its language server
   is `gonpls`. Ordinary Go projects remain **Go**; this same extension uses
   official `gopls` for them and `go` for execution.

You can keep Go and Gon folders open in the same multi-root window. Each Gon
folder has its own LSP client and compiler settings. Standard Go projects also
get their own official gopls client when the Go extension is disabled. This extension does not
register `.go` as a global Gon file association. **Gon: Disable for This Project**
restores the Go language mode.

Configuration for explicit tool paths:

```json
{
  "gon.enabled": true,
  "gon.compilerPath": "/path/to/toolchain/gon/bin/gon",
  "gon.languageServerPath": "/path/to/toolchain/gon/bin/gonpls"
}
```

For ordinary Go projects, `gon.goPath` selects the Go command and
`gon.goLanguageServerPath` selects official gopls (default `gopls`, also searched
in GOBIN/GOPATH/bin). `gon.goServerSettings` configures that server separately.

Paths support `~` and `${workspaceFolder}`. Bare names use `PATH`. The tools must
be installed in the same environment as the extension host (local, SSH, WSL, or
container). Workspace trust is required to start tools or execute code.

## Run button

The **▶ Run Go/Gon File** button appears in the editor title for saved `.go` files
other than `_test.go`. It saves the active file and runs:

- `gon run <file>` in a Gon project;
- `go run <file>` in an ordinary Go project.

Output and compiler errors appear in a VS Code task terminal. Stop the running
task from the terminal/task controls. A file must contain a runnable `main`
package; library files are rejected by the compiler. For multi-file programs,
set `"gon.run.mode": "package"` to run the containing package instead.
`gon.run.args` is an array of program arguments. Paths and arguments are passed
directly to the process, so spaces and shell metacharacters are preserved.
`gon.goPath` selects the official Go executable for ordinary Go projects.

## Language features

Diagnostics, completion, hover, definitions, references, rename, formatting,
semantic tokens, and import actions are provided by the selected server through
the standard VS Code language client: official gopls for Go, gonpls for Gon. `gon.serverSettings` passes gopls-style settings to
that server. Use **Gon: Restart Language Server** after changing or rebuilding
Gon tools. The **Gon** output channel contains both servers' logs. If formatting
was explicitly assigned to the now-disabled Go extension, use **Format Document
With... → Configure Default Formatter → Gon** for Go files. Gon files already
default to this extension.

**Gon: Check Project (saved files)** runs `gon check ./...` for the selected Gon
project as a task and reports its diagnostics, including files that are not
open, in the Problems view. **Gon: Show Tooling Capabilities** prints what the
project's toolchain reports through `gon capabilities --json`. The extension
probes this before offering tooling features and, when the toolchain is too old,
explains that it must be updated instead of falling back to other tools. When
`gon.languageServerPath` is not set, it starts the language server that the
selected compiler reports, so each project uses its own toolchain.

Leaving the official extension active is not required. If it is already active,
Gon defers ordinary Go language features to it rather than start duplicate Go
providers. Disable it and reload to use this extension alone.

## Debugger

Install Delve (`dlv`) alongside the tools, or set `gon.debuggerPath`. Press F5
and choose **Gon / Go**, or use this `.vscode/launch.json` entry:

```json
{
  "type": "gon",
  "name": "Launch package",
  "request": "launch",
  "mode": "debug",
  "program": "${workspaceFolder}"
}
```

The selected project's compiler builds the binary. Delve consumes its normal
Go debug information directly; no source translation is involved. Breakpoints,
stepping, stack frames, variables and Watch expressions use native Delve DAP.
Program output appears in the Debug Console. `mode: "test"` debugs package tests;
`mode: "exec"` launches an existing binary. Local attach accepts `processId`;
`port` and `host` connect to an existing DAP server. Existing `type: "go"`
configurations are supported when this extension owns Go debugging.

Each session gets its own compiler environment. Go/Gon coexistence does not
require changing your shell PATH or global GOROOT. Delve remains the shared
`dlv` executable and is not replaced. `stdinFrom`, `stdoutTo`, and `stderrTo`
can redirect streams; use `outputMode: "local"` with output redirection.

## Test explorer

Open VS Code's **Testing** view and refresh. The explorer discovers actual
`Test`, `Example`, `Fuzz` and `Benchmark` entries using the selected compiler.
Use its Run and Debug profiles for a project, package, test, or discovered
subtest. Runs show output, passed/failed/skipped results and elapsed time;
Cancel terminates the test process group. Source changes trigger a refresh.
Fuzz entries run their seed corpus; continuous fuzzing is available through
`gon test -fuzz` in a terminal.

- `gon.test.packagePatterns`: package patterns to discover (default `./...`).
- `gon.test.buildFlags`: build flags, e.g. `["-tags=integration"]`, shared by
  discovery, running and debugging.
- `gon.test.args`: extra arguments for normal test runs.

Discovery compiles tests, so build failures appear on the project node. For a
workspace containing separate modules, open each module as a workspace folder
or configure appropriate package patterns. Test compilation can execute build
tools; workspace trust is required.

The extension retains upstream source, but does not include every upstream
integration or an automatic tool installer. Gon syntax support in analysis is
provided by the patched gonpls SSA and Staticcheck IR builders.

## Build and test

Requires Node.js 22+ and npm, plus the built Gon tools for integration tests.

```sh
cd extension
npm ci
npm run compile
npm run package
code --install-extension ../gon-0.1.0.vsix
```

The VSIX is local; `gon-lang` is the extension namespace, not a claim that this
extension has been published to the marketplace.

```sh
GON_ROOT=/path/to/gon-toolchain \
GO_ERROR_HANDLING_BASELINE=/path/to/official/go \
npm test
```

The runner uses an isolated VS Code profile and temporary projects. Set
`VSCODE_EXECUTABLE` to an installed VS Code executable to avoid downloading a
test version. Set `GON_TEST_GOPLS` to an existing official gopls executable if
it is outside PATH/GOPATH. `GON_TEST_DLV` selects an installed Delve for tests. The tests disable all other third-party extensions
and verify Go/Gon coexistence in one window, actual gonpls
hover and error diagnostics, official gopls for legacy Go, a second Gon server,
command routing across all three projects, the play-button contribution, execution of
paired legacy/modern programs, saving edits, paths containing spaces and shell
metacharacters, and enabling/disabling Gon per project. They also run real Delve sessions,
check breakpoints/locals/evaluation/stepping, discover tests, run and debug
them, report failures/skips/subtests, and cancel a running test. The tooling
checks probe capabilities, reject an older toolchain and ordinary Go projects,
and run Check Project on clean and broken code, asserting exit status and the
reported problem.

## Upstream and license

Forked from [golang/vscode-go](https://github.com/golang/vscode-go), commit
`f30f369e48e3772be1b5622647664f05f2ddc076`. The `upstream` Git remote points to that
repository; no Gon remote or published repository is configured yet.
Upstream attribution and MIT license are preserved. The original documentation
is retained in `docs/UPSTREAM-README.md` and the Git history.

Go syntax highlighting uses VS Code's built-in `source.go` grammar. The Gon
language configuration is derived from the built-in Go extension in VS Code
1.139.1 (Microsoft, MIT license); additional Gon tokens and semantic highlighting
come from this extension and gonpls.

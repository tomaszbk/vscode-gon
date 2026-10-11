# Gon for Visual Studio Code

Gon language support, derived from the official Go extension. This fork has
its own extension ID, `gon-lang.gon`. Enable it in Gon workspaces and disable
the official `golang.go` extension there. For ordinary Go workspaces, disable
Gon and enable the official Go extension.

The Gon compiler and `gonpls` language server are maintained in the Gon toolchain
repository. This extension does not install or replace tools automatically.

## Use

1. Install the Gon toolchain with `python3 misc/gon/install.py` from its checkout.
   The installer exposes `gon` and `gonpls` and updates your public PATH when
   needed. Open a new terminal and restart VS Code after installation.
2. Download `gon-0.1.0.vsix` from [Gon releases](https://github.com/tomaszbk/gon/releases)
   and install it with **Extensions: Install from VSIX...** or
   `code --install-extension gon-0.1.0.vsix`. Disable **Go** (`golang.go`)
   **for this workspace**, and reload VS Code.
3. Open a `.go` file. The editor language becomes **Gon**, with `gonpls` providing
   language services and `gon` used for execution, tests and debugging.

No `go.mod` change, `gon.enabled` flag, project-enabling command or settings file
is required. The extension searches PATH and `~/.local/bin`, including when a GUI
editor inherited an older PATH. The default server follows the selected compiler's
capabilities metadata. Terminal and CI commands still need to use `gon` explicitly;
the extension does not change the terminal's environment.

Optional overrides for a particular toolchain:

```json
{
  "gon.compilerPath": "/path/to/toolchain/gon/bin/gon",
  "gon.languageServerPath": "/path/to/toolchain/gon/bin/gonpls"
}
```

Overriding only the compiler also selects its corresponding gonpls. Paths support
`~`, `${workspaceFolder}` and project-relative paths. Tools must be installed in
the same environment as the extension host (local, SSH, WSL or container).
Workspace trust is required to start tools or execute code.

Each folder has a separate language client and may override the tool paths.
Extension enablement applies to the whole workspace, including every folder;
use separate windows when you need Go and Gon extensions for different projects.
This extension does not register `.go` as a global Gon file association. Old
`gon.enabled` settings are ignored and can be removed.

## Run button

The **▶ Run Gon File** button appears in the editor title for saved `.go` files
other than `_test.go`. It saves the active file and runs `gon run <file>`.

Output and compiler errors appear in a VS Code task terminal. Stop the running
task from the terminal/task controls. A file must contain a runnable `main`
package; library files are rejected by the compiler. For multi-file programs,
set `"gon.run.mode": "package"` to run the containing package instead.
`gon.run.args` is an array of program arguments. Paths and arguments are passed
directly to the process, so spaces and shell metacharacters are preserved.

## Language features

Diagnostics, completion, hover, definitions, references, rename, formatting,
semantic tokens, and import actions are provided by gonpls through the standard
VS Code language client. `gon.serverSettings` passes gopls-style settings to
that server. Use **Gon: Restart Language Server** after changing or rebuilding
Gon tools. The **Gon** output channel contains language-server logs. If formatting
was explicitly assigned to the now-disabled Go extension, use **Format Document
With... → Configure Default Formatter → Gon** for Go files. Gon files already
default to this extension.

The Gon grammar highlights contextual `enum` and `enum string` declarations,
pattern tests with `is`, error handlers with `or`, lambda/match `=>`, and
`?`, `?.`, `??`, `??=`. Quoted and raw interpolation keep literal text as
strings and tokenize embedded expressions, nested literals and fmt verbs.
`enum`, `is` and `or` keep ordinary identifier highlighting outside their
syntax; gonpls supplies precise semantic tokens and binding scopes.
Match arms also have indentation support. Native optionals use direct payloads
and nil; `gonoption` and `gonmaybe` provide a declaration and exhaustive match.
The eight Gon snippets include enums, string enums, optional values, matches,
named calls, conditional expressions and lambdas.

NilAway warnings are opt-in. Add this object to workspace settings:

```json
{
  "gon.serverSettings": { "nilaway": true }
}
```

**Gon: Check Project** inherits that setting and invokes `gon check --nilaway`
when enabled. The language-server setting is passed through an open object;
other gonpls options remain available.

## Debugger

Install Delve (`dlv`) alongside the tools, or set `gon.debuggerPath`. Press F5
and choose **Gon**, or use this `.vscode/launch.json` entry:

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

Each session gets its own Gon compiler environment without changing the
terminal's Go selection or global GOROOT. Delve remains the shared
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

The VSIX is distributed with [Gon releases](https://github.com/tomaszbk/gon/releases).
`gon-lang` is the extension namespace; installation uses the downloaded VSIX.

```sh
GON_ROOT=/path/to/gon-toolchain \
GON_BASELINE_GO=/path/to/official/go \
npm test
```

Set `GON_TEST_SETUP_ONLY=1` with those variables to exercise automatic tool
selection, LSP, run/check, debugging and the test explorer without the separate
core-language fixtures. Those checks execute legacy Go on both Gon and the
unmodified baseline, plus modern error handling on Gon. This mode does not
validate enum/optional/named-call editor fixtures.

Set `GON_TEST_FEATURES_ONLY=1` with those variables for the focused
enum/match/native optional/error-tuple/named-call and new syntax extension-host checks and executable
legacy/modern/baseline pair. With `VSCODE_EXECUTABLE` set, `npm run test:syntax`
tests highlighting with that editor's actual TextMate tokenizer and built-in
Go grammar, plus match indentation and snippet packaging, without starting
the extension host. The normal `npm test` also includes these feature checks.

The runner uses an isolated VS Code profile and temporary projects. Set
`VSCODE_EXECUTABLE` to an installed VS Code executable to avoid downloading a
test version. `GON_TEST_DLV` selects an installed Delve for tests. The tests disable
other third-party extensions and verify automatic Gon selection with no project
settings, public PATH discovery, actual gonpls hover and error diagnostics,
independent clients and command routing, an optional compiler override, the play
button, paired legacy/modern/baseline execution, saving edits, and paths containing
spaces and shell metacharacters. They also run real Delve sessions, check
breakpoints/locals/evaluation/stepping, discover tests, run and debug them,
report failures/skips/subtests, and cancel a running test.

## Upstream and license

Forked from [golang/vscode-go](https://github.com/golang/vscode-go), commit
`f30f369e48e3772be1b5622647664f05f2ddc076`. The `upstream` Git remote points to that
repository. The maintained Gon source has a separate origin repository; public
VSIX downloads are distributed from the Gon toolchain's releases.
Upstream attribution and MIT license are preserved. The original documentation
is retained in `docs/UPSTREAM-README.md` and the Git history.

Go syntax highlighting uses VS Code's built-in `source.go` grammar. The Gon
language configuration is derived from the built-in Go extension in VS Code
1.139.1 (Microsoft, MIT license); additional Gon tokens and semantic highlighting
come from this extension and gonpls.

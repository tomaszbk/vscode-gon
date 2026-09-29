# Gon extension validation

Validated on macOS arm64 with VS Code 1.139.1, official Go 1.27.1/gopls 0.23.0,
Delve 1.27.2, and the Gon toolchain at `/Users/tzbk/Documents/go`.

From `extension/`:

```sh
GON_ROOT=/Users/tzbk/Documents/go \
GO_ERROR_HANDLING_BASELINE=/opt/homebrew/bin/go \
GON_TEST_GOPLS=/Users/tzbk/go/bin/gopls \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
npm test
```

Passed with **only the Gon extension active** in an isolated VS Code profile.
Three folders were open in one window: two Gon projects and one ordinary Go
project. Verified:

- Gon language selection only for opted-in projects; Go stays Go elsewhere.
- Official gopls hover for ordinary Go; gonpls hover for Gon error bindings.
- Independent Gon clients and routing of server commands for all three folders.
- Real type errors appear and clear after unsaved edits are repaired.
- The editor-title command is contributed with the play icon.
- The registered Run File command executes real legacy/modern programs using
  official Go/Gon, with equal asserted outputs and exit status zero.
- Dirty code is saved before execution; paths/program arguments containing
  spaces and `&` survive direct process argument passing.
- Disable/enable switches document language without affecting other projects.

`npm run package` generated `gon-0.1.0.vsix`, and the VSIX was installed locally
using `code --install-extension`. No marketplace publication or remote Gon
Git repository was created. `npm audit --omit=dev` reported zero vulnerabilities.

The toolchain repository's `misc/gon/test.py` also passed after adding the `gon`
LSP language ID and `gonpls.*` command namespace. It includes executable
legacy/modern/baseline comparisons and real stdio LSP requests.

The debugger and test explorer are now implemented. Additional real extension-host
checks pass with the official extension disabled:

- Compiler-backed test discovery and source navigation for both toolchains.
- Passing, failing and skipped tests, dynamically discovered subtests, and
  selected/excluded subtests.
- Native Delve debug sessions for passing and failing tests; test and subtest
  output/status arrive through DAP into the explorer.
- Cancellation of a long-running test and process-group cleanup.
- Source breakpoints in Go/Gon, stack frames, local variables, Watch evaluation,
  stepping and continuation to exit status zero.
- Existing `type: "go"` configurations, plus the new `type: "gon"`.
- Paths containing spaces and `&`, and macOS symlinked workspace paths.

No Delve fork was required: Gon emits ordinary Go DWARF. Each spawned DAP server
gets the selected compiler's GOROOT and PATH without changing global settings.
Program output defaults to the Debug Console (`outputMode: "remote"`).

Validation ran locally on macOS arm64. Attach/remote DAP configuration is
implemented but was not exercised against a remote target. Continuous fuzzing,
coverage profiles, and upstream custom integrations are not claimed here;
see README.md for the supported scope.

## Gon file icon fix

The Gon language contribution now provides the existing upstream blue Go logo
as its light/dark fallback icon. The image is explicitly included in the VSIX.
An isolated VS Code extension-host smoke run opened `main.go` in Gon mode with
the Seti icon theme. Packaging and type checking passed. The updated local VSIX
was reinstalled; existing windows need Reload Window to load new contributions
and the rebuilt gonpls cancellation fix.

## Gon tooling integration

Validated on 2026-09-29 on macOS arm64 with VS Code 1.139.1 (isolated profile,
only the Gon extension active), official Go 1.27.1/gopls, and the Gon toolchain
at `/Users/tzbk/Documents/gon` including the new `gon` tooling commands.

```sh
cd extension
npm run typecheck
GON_ROOT=/Users/tzbk/Documents/gon \
GO_ERROR_HANDLING_BASELINE=/opt/homebrew/bin/go \
GON_TEST_GOPLS=/Users/tzbk/go/bin/gopls \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
npm test
npm run package
```

All passed, including the earlier coexistence, LSP, run, debugger and test
explorer checks. The new checks verify the contributed commands and problem
matcher, the schema version 1 capabilities of the selected toolchain and its
language server path, that official Go is reported as a toolchain needing an
update, that Check Project refuses an ordinary Go project, and that it runs
`gon check ./...` with exit status 0 on the clean Gon project and 1 after adding
an invalid `!` use in a file that was never opened, whose `InvalidErrorHandling`
problem appears through the `$gon-check` matcher.

`npm run package` regenerated `gon-0.1.0.vsix`. It was not installed.

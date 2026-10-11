# Current Gon extension validation

The Gon 2.27 integration passes targeted checks on macOS arm64 with VS Code
1.140.0, the native Gon toolchain at `/Users/tzbk/Documents/gon`, and the
unmodified Go 1.27.1 baseline. Run from `extension/`:

```sh
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:syntax
npm run compile
GON_ROOT=/Users/tzbk/Documents/gon \
GO_ERROR_HANDLING_BASELINE=/opt/homebrew/bin/go \
GON_TEST_FEATURES_ONLY=1 \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm test
npm run package
```

All exited 0. The actual VS Code TextMate/Oniguruma tokenizer checks ordinary
and generic enums, string enums, native optional types and presence patterns,
contextual `is`, block and one-line `or`, and quoted/raw interpolation. Embedded
expressions cover nested quotes, maps, slice indexes, named calls, conditional
expressions, nested interpolation, comments and fmt verbs. Escaped dollars and
ordinary Go identifiers retain their meanings. Match indentation and packaging
of all eight Gon snippets pass; retired Result constructors and snippets are
absent. TypeScript checking and bundling pass.

The isolated extension host uses the actual language client to verify enum,
optional, error-tuple and named-call hover, definitions, signatures and formatting.
Pattern bindings complete in later `&&` operands, and references inside
interpolation navigate and rename together with their declaration. Multi-pattern
arms, one-line error context and interpolation execute in the modern example;
modern Gon, legacy Gon and unmodified Go produce identical asserted output.

The same focused run executes **Gon: Check Project** with NilAway disabled and
enabled through the `gon.serverSettings` object. Its task arguments omit or
include `--nilaway` accordingly, and both checks complete with exit 0. Server
settings remain an open object; no extra setting schema blocks new gonpls keys.

`npm run package` regenerated `gon-0.1.0.vsix`. Archive inspection confirms the
current interpolation grammar, embedded Gon expression scopes, all eight
snippets, language configuration and bundled client. The package was not
published. This update did not rerun the separate full debugger and test explorer
suite; its earlier macOS evidence remains separate from these current language
and configuration checks.

## Baseline environment cleanup — 2026-10-07

The preceding validation record is preserved. After replacing the retired
baseline environment variable in the current runner and README instructions,
`npm run typecheck` and the normal `npm test` both exited 0 on macOS arm64.
The extension host completed at 14:55:22 Argentina time. Run from `extension/`:

```sh
npm run typecheck
env -u GO_ERROR_HANDLING_BASELINE -u GON_TEST_FEATURES_ONLY -u GON_TEST_SETUP_ONLY \
GON_ROOT=/Users/tzbk/Documents/gon \
GON_BASELINE_GO=/opt/homebrew/bin/go \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
GON_TEST_DLV=/Users/tzbk/go/bin/dlv npm test
```

This run used the current baseline variable without feature/setup filters.
It passed the actual VS Code tokenizer, the language-service feature checks,
and legacy/modern/baseline execution. The complete extension suite also passed
automatic tool discovery, per-folder overrides, LSP, file execution, debugger
breakpoints/stack/locals/evaluation/stepping, and the test explorer for both
Gon and legacy Go projects. The runner used temporary projects and an isolated
VS Code profile.

## Gon 2.27.0 distribution and client lifecycle — 2026-10-11

The normal full `npm test` passed with the native Gon toolchain, unmodified
Go 1.27.1 and the installed VS Code executable, without setup/feature filters.
It executed the tokenizer, real LSP services and configuration changes, paired
legacy/modern/baseline programs, automatic discovery, Run File, debugger and
test explorer. A new post-run log check confirmed no language-client startup
or workspace/didChangeConfiguration failure in the isolated VS Code profile.

Configuration is passed through initialization and workspace/configuration;
Gon serializes restarts when tool paths or server settings change. The redundant
generic didChangeConfiguration feature is no longer registered, preventing it
from automatically starting a client while Gon is stopping that client.
The full integration run exercises NilAway setting changes and subsequent LSP
requests. The test runner now treats hidden output-channel lifecycle errors
as failures even when its feature assertions succeed.

Run from `extension/`:

```sh
GON_ROOT=/Users/tzbk/Documents/gon \
GON_BASELINE_GO=/opt/homebrew/bin/go \
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
GON_TEST_DLV=/Users/tzbk/go/bin/dlv npm test
npm run package
```

The resulting `gon-0.1.0.vsix` is distributed with Gon 2.27.0 on the public
Gon repository. Its bundled client, grammar, snippets, license and documentation
are checked in the archive.

On 2026-10-11 the same package was published as
[`gon-lang.gon` 0.1.0 on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gon-lang.gon).
The public gallery reports the version as validated and its VSIX SHA256 as
`64b3a6f4da8662ce0b3334082127bc67fc7433c54ac887c6a8d7ab791b58f7f0`,
matching the tested package from source commit `7d1dfc4bf511c525d5adc9e054a84eb1023e721f`.
Installation with `code --install-extension gon-lang.gon@0.1.0 --force` passed
on macOS arm64 using separate user-data and extension directories. The installed
client, grammar, snippets, language configuration, icons, license, README and
changelog match the original VSIX bytes. The public listing exposes its Install
button. The subsequent repository documentation edits do not change the
published package or repeat the earlier integration-test run.

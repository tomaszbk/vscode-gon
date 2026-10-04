# Current Gon extension validation

The full suite passes on macOS arm64, VS Code 1.139.1, Go 1.27.1, Delve 1.27.2
and the current native Gon toolchain at `/Users/tzbk/Documents/gon`.
Run from `extension/`:

```sh
GON_ROOT=/Users/tzbk/Documents/gon \
GO_ERROR_HANDLING_BASELINE=/opt/homebrew/bin/go \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm test
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:syntax
npm run package
```

All exited 0. The actual VS Code TextMate/Oniguruma tokenizer checks nested
operators, contextual enum declarations, native optional types and presence
patterns, Result-only contextual constructors, identifier compatibility,
comments/strings, arm indentation and the eleven current Gon snippets.

The isolated extension host executes the current language client and verifies
native optional/Result/enum/match/named-argument hover, definitions, signatures,
completion, formatting, presence bindings and paired modern Gon, legacy Gon
and unmodified Go execution with identical asserted output. There are no
predeclared Option/Some/None constructors or snippets.

The same full run verifies automatic Gon selection without project settings,
public PATH discovery and fallback, per-folder tool-path overrides, independent
LSP clients, saved Run File tasks, safe paths/arguments, Check Project and
problems from unopened files. Native debugger checks cover source breakpoints,
stack/locals, Watch, stepping, exit status and Go/Gon adapter names. Test explorer
checks include discovery/navigation, passing/failing/skipped tests, subtests,
exclusions, Delve debug, cancellation and process-group cleanup.

`npm run package` regenerated `gon-0.1.0.vsix`. Archive inspection confirms all
11 Gon snippets, the Result-only contextual grammar, language configuration,
bundle and logo are included. The package was not published to the marketplace.
This run did not test remote/attach debugging, remote extension hosts, Windows
or additional runtime architectures. Current results replace chronological
validation notes; superseded language syntax is not retained as an active API.

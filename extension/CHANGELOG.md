# Changelog

## 0.1.0

- Independent Gon extension identity and per-folder language server.
- Go/Gon coexistence without globally claiming `.go`.
- Run File button with save, isolated compiler selection, and direct argument passing.
- VS Code integration regression tests using real Go/Gon programs and gonpls.

- Native Delve DAP debugger with project-specific Go/Gon builds, including existing `type: go` configurations.
- Test explorer with compiler-backed discovery, run/debug profiles, subtests, failures, skips and cancellation.

- Restore a file icon when `.go` documents switch into Gon language mode.

- Gon tooling integration: capability detection through `gon capabilities --json`,
  **Gon: Check Project (saved files)** with a `$gon-check` problem matcher, and
  **Gon: Show Tooling Capabilities**.

# R3 — CLI wrapper

**Status:** Stub. Drafted in Phase 2.

## Purpose

Thin command-line wrapper around the Configuration API (F2 / R1) for human and script use outside `/gan`. Same backend; same validation; same resolved-config view as agents see.

## Anticipated content

- Commands:
  - `gan validate` — runs `validateAll()` and reports issues.
  - `gan config get <path>` — prints a single resolved value.
  - `gan config set <path> <value> [--tier project|user]` — calls the updater.
  - `gan config print` — prints the full resolved config (the same view spec O1's `--print-config` exposes).
  - `gan stacks list` — lists active stacks with tiers.
- Output formats: human-readable by default, `--json` for scripting.
- Exit codes: 0 success, non-zero per documented error categories.
- Distribution: shipped as part of the R1 npm package; `install.sh` puts `gan` on PATH.

## Dependencies

- F2 (API contract)
- R1 (MCP server backend)

## Bite-size note

Each subcommand is a small sprint on its own. Skeleton + `validate` first; others follow as drivers materialize.

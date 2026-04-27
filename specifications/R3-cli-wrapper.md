# R3 — CLI wrapper

## Problem

Humans and shell scripts need a way to interact with the Configuration API outside `/gan` — to validate configuration before committing it, to inspect resolved overlays during debugging, to script bulk changes in CI. The MCP server (R1) is reachable from Claude Code but not from a regular shell. R3 exposes the same API as a command-line tool.

## Proposed change

A `gan` binary, distributed alongside the MCP server in the same npm package (`@claudeagents/config-server`). `install.sh` (R2) puts it on PATH.

### Architecture

`gan` is a thin wrapper. Each subcommand:

1. Spawns the R1 server in CLI mode (the same Node code; a flag selects stdio-MCP vs. local invocation).
2. Calls the corresponding F2 function.
3. Formats the result for human or JSON output.
4. Exits with a documented code.

There is no duplicate logic between the MCP server and the CLI; the CLI is a different transport for the same backend.

### Subcommand surface

```
gan validate                            Run validateAll() and print a report.
gan config print [--json]               Print the full resolved config.
gan config get <path> [--json]          Print one resolved value.
gan config set <path> <value> [--tier=project|user]
                                        Update a single splice point.
gan stacks list                         List active stacks with tier provenance.
gan stack show <name>                   Print one stack's full data.
gan stack update <name> <field> <value>
                                        Update one field of a stack file.
gan modules list                        List registered modules + pairsWith status.
gan version                             Print API version, server version, schemas in use.
gan --help                              Help text.
gan <subcommand> --help                 Per-subcommand help.
```

### Output format

Default output is human-readable: tables for lists, key-value pairs for single values, structured prose for validation reports.

`--json` on any read subcommand emits the raw API response unchanged. This is the contract for scripting; the JSON shape matches what the API tools return.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Validation failure (config has issues; the report is on stdout) |
| 3 | Schema mismatch |
| 4 | Invariant violation |
| 5 | API/server unreachable (R1 not installed or crashed) |
| 64 | Bad CLI arguments |

Documented so CI scripts can act on specific failures.

### Where it runs

`gan` runs anywhere a shell runs. It does not require Claude Code; it talks directly to a local invocation of the R1 server. Useful contexts:

- A user verifying their `.claude/gan/project.md` before committing.
- A pre-commit hook running `gan validate`.
- A CI job running `gan validate` on a branch.
- A script that wants to bulk-update overlays via `gan config set`.

### What `gan` does not do

- It does not run sprints. `/gan` (the Claude Code skill) is the sprint runner; `gan` (the CLI) is the configuration tool. Distinct namespaces, distinct purposes.
- It does not edit free-form `conventions` prose (consistent with F2's read-only stance for prose).
- It does not replace overlay hand-editing; it complements it.

### Install

Comes with the npm package R2 already installs. No additional install step. After R2 succeeds, `gan` is on PATH.

## Acceptance criteria

- After `install.sh` completes successfully, `gan version` runs from any shell and reports the installed versions.
- `gan validate` exits with code 0 on a clean fixture and code 2 with a structured report on a fixture with a malformed overlay.
- `gan config print --json` produces JSON that round-trips through `jq` cleanly.
- `gan config set runner.thresholdOverride 8` updates the project overlay (creating it if absent), and a subsequent `gan config get runner.thresholdOverride` returns 8.
- `gan stacks list` reflects the same active set the API exposes inside `/gan`.
- Running `gan` against a project where the MCP server is uninstalled produces exit code 5 with a remediation hint pointing at `install.sh`.

## Dependencies

- F2 (API contract)
- R1 (server backend)
- R2 (installer puts the binary on PATH)

## Bite-size note

Each subcommand is independently sprintable. Recommend ordering: `version`, `validate`, `config print`, `config get`, then writes. Reads first builds confidence in the wrapper's plumbing before writes risk corrupting state.

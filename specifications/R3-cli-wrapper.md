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
gan trust info [--project-root=<path>]  Show approval status, command-paths the approved overlay invokes, and a reminder that the trust hash does not cover those targets transitively.
gan trust approve --project-root=<path> [--note=<text>]
                                        Approve the current content hash for the named project. Trust-mutating; --project-root is REQUIRED (no cwd default), to prevent approving the wrong project from the wrong directory.
gan trust revoke --project-root=<path>  Remove approval. Trust-mutating; --project-root is REQUIRED.
gan trust list                          List all current approvals.
gan trust export [--out=<path>] [--no-notes] [--project-root=<path>]
                                        Write the trust cache (or a project slice) to a JSON manifest for CI consumption. --no-notes drops the `note` field for repos where notes contain sensitive context.
gan trust import <path>                 Merge a trust manifest into the local cache. Logs each imported approval with provenance.
gan migrate-overlays --to=<schemaVersion>
                                        Best-effort upgrade of overlay files in the current project to the named schema version. Refuses on any non-additive bump unless `--force`. Backs up originals to `.claude/gan/.migration-backup-<timestamp>/` before writing.
gan version                             Print API version, server version, schemas in use.
gan --help                              Help text.
gan <subcommand> --help                 Per-subcommand help.
```

**Trust-mutating commands** (`gan trust approve`, `gan trust revoke`) require `--project-root` explicitly. Other commands default `--project-root` to the canonical form of the current working directory; trust-mutating commands do not, to prevent the "approved the wrong project from the wrong terminal" footgun.

### Help text

Every user-facing entry point exposes help on demand.

- `gan --help` (and `gan -h`, `gan help`) prints a top-level summary: one-line description of `gan`, the subcommand list with one-line descriptions, the global flags (`--json`, `--project-root`), the exit-code table, and a pointer to per-subcommand help.
- `gan <subcommand> --help` (and `gan <subcommand> -h`) prints the subcommand's full surface: usage line, every flag and positional argument with type and default, at least one realistic invocation example, and the subset of exit codes that subcommand can produce. Trust-mutating commands additionally print the explicit `--project-root` requirement and the "approved the wrong project from the wrong terminal" rationale.
- `gan` invoked with no subcommand prints the same content as `gan --help` and exits 0 (not 64) — bare invocation is treated as a help request, not a malformed command.
- Unknown subcommands and unknown flags exit 64 (bad CLI arguments) with a one-line error pointing at `--help`. Help text never references maintainer-only scripts (per the roadmap's user-facing discipline rule).
- Help output goes to stdout (so `gan --help | less` works) and exits 0.

The help surface is the user's first contact with the tool when something goes wrong; it is part of the contract, not a nice-to-have. Tests assert non-empty content, the presence of every documented subcommand and flag, and that exit codes are 0 for help requests and 64 for malformed argument errors.

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
- `gan --help`, `gan -h`, `gan help`, and bare `gan` (no arguments) all print the top-level help to stdout and exit 0. Help text lists every subcommand from the surface table.
- `gan <subcommand> --help` and `gan <subcommand> -h` print the subcommand's usage, flags, at least one example, and applicable exit codes; exits 0.
- Unknown subcommands and unknown flags exit 64 with a one-line error and a pointer to `--help`.

## Dependencies

- F2 (API contract)
- R1 (server backend)
- R2 (installer puts the binary on PATH)

## Bite-size note

Each subcommand is independently sprintable. Recommend ordering: `version`, `validate`, `config print`, `config get`, then writes. Reads first builds confidence in the wrapper's plumbing before writes risk corrupting state.

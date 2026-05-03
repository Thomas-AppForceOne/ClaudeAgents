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
gan stacks new <name> [--tier=project|repo]
                                        Scaffold a minimal stack file at the named tier (default: project, writing to `.claude/gan/stacks/<name>.md`). The scaffold is intentionally stub-quality: every required C1 field is present but written as an obvious TODO placeholder, and the file opens with a `# DRAFT — replace TODOs and remove this banner before committing.` banner that R4's `lint-stacks` treats as a hard error until removed. See "Scaffold contract" below.
gan stacks available [--json]           List the built-in stacks the framework ships at `<packageRoot>/stacks/`. Prints a `NAME / VERSION / DESCRIPTION` table by default; `--json` emits `{"stacks": [{description, name, path, schemaVersion}, ...]}`. Distinct from `gan stacks list` (active set) and from "installed" (vendored via `gan stacks customize`).
gan stacks customize <name> [--tier=project|user] [--force]
                                        Copy the named built-in stack into a customisation tier so the user can edit it (`<projectRoot>/.claude/gan/stacks/<name>.md` for `--tier=project`, the default; `<userHome>/.claude/gan/stacks/<name>.md` for `--tier=user`). Refuses to overwrite an existing customisation without `--force`.
gan stacks reset <name> [--tier=project|user]
                                        Delete the customisation copy at the named tier so the framework's built-in default re-wins resolution. Idempotent: a missing customisation prints a one-line warning and exits 0.
gan stacks where [<name>]               Print the resolved location of a stack file. With no name, prints the absolute path to the framework's built-in stacks directory. With a name, calls R1's `getStackResolution` and prints `<path>  (tier: <tier>)` where tier is one of `project`, `user`, or `builtin` (per C5).
gan stack show <name>                   Print one stack's full data.
gan stack update <name> <field> <value>
                                        Update one field of a stack file.
gan modules list                        List registered modules + pairsWith status.
gan version                             Print API version, server version, schemas in use.
gan --help                              Help text.
gan <subcommand> --help                 Per-subcommand help.
```

**Active vs. available vs. installed.** `gan stacks list` reports the **active** set — stacks whose detection rules currently match this project's tree. `gan stacks available` lists what the framework **offers** — built-in stacks at `<packageRoot>/stacks/`. A stack is **installed** (vendored) when `gan stacks customize <name>` copies it into a customization tier (`<projectRoot>/.claude/gan/stacks/` for `--tier=project` or `<userHome>/.claude/gan/stacks/` for `--tier=user`); the customization-tier copy then wins resolution per C5's tier ordering. `gan stacks reset <name>` drops the customization so the built-in default kicks back in.

**Trust commands** (`gan trust info`, `gan trust approve`, `gan trust revoke`, `gan trust list`) live in [R5](R5-trust-cache-impl.md) so the trust UX is co-located with its implementation. They are part of the same `gan` binary, just spec'd elsewhere.

**Schema-migration tooling** (a future `gan migrate-overlays` or similar) is **not** in v1. The framework's first shipped schema is `schemaVersion: 1`; there is nothing yet to migrate from. When the first schema bump lands, the migration tooling gets its own spec authored at that point — not before. Premature migration tooling would lock in assumptions about how schemas evolve before any real evolution has happened.

### Help text

Every user-facing entry point exposes help on demand.

- `gan --help` (and `gan -h`, `gan help`) prints a top-level summary: one-line description of `gan`, **a one-line note distinguishing the CLI from the skill** (`Note: to run a sprint, use the /gan skill in Claude Code; this CLI manages configuration only.`), the subcommand list with one-line descriptions, the global flags (`--json`, `--project-root`), the exit-code table, and a pointer to per-subcommand help.
- `gan <subcommand> --help` (and `gan <subcommand> -h`) prints the subcommand's full surface: usage line, every flag and positional argument with type and default, at least one realistic invocation example, and the subset of exit codes that subcommand can produce. Trust-mutating commands additionally print the explicit `--project-root` requirement and the "approved the wrong project from the wrong terminal" rationale.
- `gan` invoked with no subcommand prints the same content as `gan --help` and exits 0 (not 64) — bare invocation is treated as a help request, not a malformed command.
- Unknown subcommands and unknown flags exit 64 (bad CLI arguments) with a one-line error pointing at `--help`. Help text never references maintainer-only scripts (per the roadmap's user-facing discipline rule).
- Help output goes to stdout (so `gan --help | less` works) and exits 0.

The help surface is the user's first contact with the tool when something goes wrong; it is part of the contract, not a nice-to-have. Tests assert non-empty content, the presence of every documented subcommand and flag, and that exit codes are 0 for help requests and 64 for malformed argument errors.

### Scaffold contract (`gan stacks new`)

The scaffold's job is to give a non-Node user a discoverable, low-friction starting point for authoring a stack file — without ever producing a stack that *looks* finished when it isn't. The friction of replacing the placeholders is the value: it's also the discoverable "you're not done yet."

Concrete scaffold output for `gan stacks new ios`:

```markdown
# DRAFT — replace TODOs and remove this banner before committing.
# `gan validate` and CI's lint-stacks will fail while this banner is present.
---
schemaVersion: 1
name: ios
detection:
  # TODO: replace with a detection composite that uniquely identifies this ecosystem.
  # See C1's schema spec and existing stacks/*.md files for examples.
  anyOf:
    - file: TODO-replace-with-marker-file
scope:
  # TODO: globs describing files this stack owns (used for cross-contamination filtering).
  - "**/*"
secretsGlob:
  # TODO: globs of files to scan for secrets.
  - "**/*"
auditCmd:
  command: "false  # TODO: replace before committing — your audit command, or remove this field"
  absenceSignal: warning
buildCmd: "false  # TODO: replace with the build command users on this stack run"
testCmd:  "false  # TODO: replace with the test command"
lintCmd:  "false  # TODO: replace with the lint command, or remove this field"
securitySurfaces: []
  # TODO: see C1's schema spec and existing stacks/*.md files for surface
  # authoring patterns. An empty list is a valid stack (it just means /gan
  # applies no client-side security checks for this ecosystem).
---

## Conventions

<!-- TODO: free-form prose describing the ecosystem's conventions, idioms,
     and anything an agent should know when working in this stack. -->
```

Discipline rules:

- **No plausible-looking defaults.** Strings that would parse as "valid but empty" (`auditCmd: "true"`, empty `securitySurfaces`, blank `buildCmd`) are forbidden; placeholders are explicitly stub strings (`"false  # TODO: replace..."`) that fail at runtime if not replaced.
- **The banner is enforcement, not decoration.** R4's `lint-stacks` fails on any stack file containing the `# DRAFT` banner. This makes "user committed a half-baked stack" a CI hard error, not a social problem.
- **The scaffold writes to `.claude/gan/stacks/<name>.md` by default** (project tier per C5). `--tier=repo` writes to `stacks/<name>.md` and is intended for maintainer use when authoring a new canonical template; user projects almost never need it.
- **No detection inference.** The scaffold does not inspect the user's repo to guess detection rules; it produces a TODO placeholder. Detection is too easy to get subtly wrong; better to make the user think about it explicitly than to ship a "smart" guess that misfires.
- **Refuses to overwrite.** If the target file exists, `gan stacks new` errors with a clear message. The user has to delete it first.

### Output format

Default output is human-readable: tables for lists, key-value pairs for single values, structured prose for validation reports.

`--json` on any read subcommand emits the raw API response unchanged. This is the contract for scripting; the JSON shape matches what the API tools return.

### Exit codes

| Code | F2 error code(s) | Meaning |
|---|---|---|
| 0 | _none_ | Success. |
| 1 | `TrustCacheCorrupt` and any unmapped error code (the safety default) | Generic failure. Unmapped F2 codes default to `1` rather than `0` so a future-added code can never accidentally surface as success. |
| 2 | `UntrustedOverlay`, `ValidationFailed` | Validation failure (config has issues; the structured report prints on stdout). The trust check fails closed on this code. |
| 3 | `SchemaMismatch`, `InvalidYAML`, `MissingFile` | Schema or shape problem at the file boundary. |
| 4 | `InvariantViolation`, `PathEscape`, `CacheEnvConflict` | Cross-file invariant violation (including the F4 path-escape and C1 cacheEnv conflicts surfaced as their own codes). |
| 5 | `UnknownApiVersion`, plus the connection-failure path when the server cannot be reached | API/server unreachable (R1 not installed or crashed) or version-mismatched. |
| 64 | `MalformedInput`, `UnknownStack`, `UnknownSplicePoint`, `NotImplemented` | Bad CLI arguments — caller-side input shape errors, references to unknown stacks/splice points, or invocation of a tool whose implementation is deferred. |

Documented so CI scripts can act on specific failures. The mapping is one-to-many in both directions: a single exit code can absorb multiple F2 codes (e.g. exit `4` covers `InvariantViolation`, `PathEscape`, and `CacheEnvConflict`), and the exit-code table is the authoritative cross-reference between the F2 enum and shell exit codes. New F2 error codes added in a future revision require a same-PR update to this table; the implementation in `src/cli/lib/exit-codes.ts` mirrors this table 1:1.

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
- `gan stacks new <name>` writes a stub stack file to `.claude/gan/stacks/<name>.md` matching the Scaffold contract above. The file opens with the `# DRAFT — replace TODOs and remove this banner before committing.` banner; every required C1 field is present as a TODO placeholder; `securitySurfaces` is an empty list with an authoring-guide pointer.
- Running `gan validate` or `lint-stacks` against the unmodified scaffold fails with a clear error citing the unremoved DRAFT banner.
- `gan stacks new <name>` against an existing file at the target path exits non-zero without overwriting; the error names the conflicting path.

## Dependencies

- F2 (API contract)
- R1 (server backend)
- R2 (installer puts the binary on PATH)

## Bite-size note

Each subcommand is independently sprintable. Recommend ordering: `version`, `validate`, `config print`, `config get`, then writes. Reads first builds confidence in the wrapper's plumbing before writes risk corrupting state.

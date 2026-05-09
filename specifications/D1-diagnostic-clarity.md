# D1 — Diagnostic clarity

## Problem

The first dogfooding session caught three diagnostic surfaces producing the wrong remediation for the user's actual situation. In each case the framework had the information needed to guide the user precisely; it just lumped distinct failure modes into a single generic message.

1. **`ConfigApiUnreachable` lumped install + restart.** The orchestrator's preflight diagnostic, when it cannot reach the Configuration API, emitted a single remediation: "Install the framework: `bash <repo>/install.sh`. Then restart Claude Code." For a user who had already run `install.sh` (and just hit the restart-required failure mode after the install completed), this remediation was misleading — they didn't need to re-install, they needed to restart Claude Code so the live session picked up the freshly-registered MCP server. The remediation is correct as a default; it was wrong as the only branch.

2. **SKILL.md described unshipped behavior with no marking.** The orchestrator skill spec describes `--recover` and `--list-recoverable` dispatching to "the recovery flow per O2's revision," but O2 is not implemented in v1.0. An orchestrator implementing the skill from scratch — or a user reading SKILL.md to understand what `/gan` does — has no signal that those flags are aspirational. The doc reads as if the behavior is operative.

3. **`gan stacks --help` advertised 2 of 6 subcommands.** The CLI ships six `stacks` subcommands (`list`, `available`, `new`, `where`, `customize`, `reset`), but the help output listed only `list` and `new`. A user running `gan stacks list` and getting back only `generic` (because they were not in a Node project) had no obvious path to discover that `gan stacks available` lists every stack the framework ships. The functionality existed; the help didn't surface it.

All three are diagnostic-surface failures: the framework had the data to guide the user well, and didn't. D1 covers all three because they share a discipline — match the diagnostic to the user's actual state, not to the most-common case.

D1 is the first spec under the **D** (diagnostics + user UX) phase code.

## Proposed change

### `ConfigApiUnreachable` branching

The orchestrator's preflight check, before calling `validateAll()` or any other framework API, runs three sub-checks:

1. **Is the framework's MCP server registered in `~/.claude.json`?** Read `~/.claude.json` (or the platform-equivalent), check for the `mcpServers.claudeagents-config` entry.
2. **Does the registered command resolve to an existing executable?** If the registration is present, check whether the command path (absolute, per I3) exists and is executable.
3. **Are framework MCP tools actually reachable in this Claude Code session?** Attempt a single MCP probe (e.g. `getApiVersion()`) and see if the response arrives.

The remediation branches on the combination:

| #1 registered? | #2 bin exists? | #3 reachable? | Remediation |
|---|---|---|---|
| No | — | — | Install: `bash <repo>/install.sh`. Then restart Claude Code. |
| Yes | No | — | Re-install: the registered bin path `<path>` does not exist. Run `bash <repo>/install.sh` to refresh the registration. |
| Yes | Yes | No | Restart Claude Code. The framework is installed but this session has not loaded the MCP registration yet — Claude Code reads `~/.claude.json` only at session startup. Quit Claude Code completely (Cmd+Q on macOS) and reopen, then re-run `/gan --print-config`. |
| Yes | Yes | Yes | (No diagnostic; the API is reachable.) |

The third branch is the load-bearing addition: a user who already installed and just needs a restart no longer cycles through "I already installed, why is it telling me to install?"

The branches are deterministic from the framework's perspective — `~/.claude.json` is readable by the orchestrator, and the registered bin path is stat-able. The "is the API reachable" check is the natural fallback because if it succeeds, no diagnostic fires anyway.

### SKILL.md status markers

The orchestrator skill spec (`skills/gan/SKILL.md`) and any other forward-looking spec MUST mark sections with status indicators when the behavior they describe is not fully shipped in the current release:

- `[shipped-in-v1.0]` — operative now; the orchestrator implements this section as written.
- `[deferred-to-v1.1]` — described for forward-compat, not yet operative; the orchestrator either no-ops, prints a "this command requires v1.1" message, or short-circuits to a different flow.
- `[partial-v1.0]` — minimal viable shipped, full version in a later release; the section names which parts are operative.

The markers appear at section-heading level in the spec (e.g. immediately after `## Inspection and recovery short-circuits`). They are also reflected in the orchestrator's behavior:

- A `--recover` invocation under v1.0 (where O2 is deferred) prints "this command requires v1.1; install the latest framework" and exits with a non-zero status code, instead of silently no-oping or attempting an undefined dispatch.
- A `--list-recoverable` invocation produces the same.

The orchestrator's runtime behavior aligning with the spec's markers is the contract that makes the markers meaningful. Without the runtime alignment, markers are just decoration.

The discipline applies prospectively to all forward-looking specs (A1, T1, E5 as they ship in stages; future H-series, V-series, B-series, Q-series specs). When a section's behavior moves from `[deferred-to-vN]` to `[shipped-in-vN]`, the marker updates in the same PR as the implementation. When a partial implementation lands, the section either splits (operative parts marked `[shipped]`, remaining parts `[deferred]`) or carries the `[partial]` marker with explicit per-bullet annotations.

The R4 maintainer-tooling spec gains a lint check (`lint-status-markers`) that walks every spec file and asserts:

- Every section heading in SKILL.md has a status marker (or is in a designated "non-shipped-behavior" prologue section like the spec's "Problem" / "Bite-size note" sections, which are about the spec itself rather than runtime behavior).
- Markers reference releases that exist in the roadmap (no `[shipped-in-v9.9]` for unreleased futures).
- Sections whose marker says `[shipped-in-v<release>]` for a release that has merged are exercised by a test (CI check that the section's behavior actually runs).

The lint runs in CI.

### `gan stacks --help` completeness

The R3 CLI's stacks-help registry currently lists `list` and `new`. Update to list all six subcommands (`list`, `available`, `new`, `where`, `customize`, `reset`) and explicitly distinguish `list` (active for current dir, detection-driven) from `available` (all stacks the framework ships, regardless of detection).

The help text gets an "Active vs. available" paragraph:

```
Active vs. available:
  list      = stacks whose detection rules match the current directory.
              In a project that matches one of the framework's shipped
              stacks, that stack appears here; otherwise `generic`
              (the fallback) is the active stack.
  available = every stack file the framework has on disk.
```

Examples in the help output include `gan stacks available` and `gan stacks customize web-node` so users see the new entry points. `gan stacks list`'s runtime output is unchanged for scripting compatibility — tests pin the format (one stack name per line, `(none)` on empty active set).

This is help-text-only; no behavior change beyond the new paragraph.

### What D1 does not do

- Address every diagnostic surface in the framework. The three covered here are the ones that bit a real dogfooding session. Future diagnostic improvements get their own specs (D2, D3, …) when usage signal warrants.
- Provide internationalization. All diagnostic messages are English; localization is post-v2.0.
- Provide structured-error machine output. The diagnostic messages are prose for humans; machine consumers read structured-error JSON via the F2 error model, which is unchanged.
- Cover the orchestrator's runtime telemetry surface (per-LLM-call summary, sprint-end summary). That is T1's scope; the heartbeat and progress lines are runtime UX, not diagnostic.

## Field encodings

D1 introduces two new schema-bearing surfaces:

- **Status-marker tokens** in spec files — `[shipped-in-v<release>]`, `[deferred-to-v<release>]`, `[partial-v<release>]`. Token format: ASCII brackets, lowercase tokens, version segment matches roadmap release labels. Lint enforces.
- **`ConfigApiUnreachable` branching discriminator** — when the orchestrator emits the structured error, it now includes a `subReason` field with values `notRegistered` | `binMissing` | `notLoadedInSession`. The error code stays `ConfigApiUnreachable`; the discriminator lets advanced consumers (logs, future telemetry) distinguish the cases.

## Examples

A user who has already installed but hasn't restarted Claude Code:

```
$ /gan --print-config
{
  "resolvedConfig": null,
  "validationErrors": [
    {
      "code": "ConfigApiUnreachable",
      "subReason": "notLoadedInSession",
      "message": "The framework is installed (`~/.claude.json` registers the MCP server at `/opt/homebrew/bin/claudeagents-config-server`) but this Claude Code session has not loaded the MCP registration yet. Claude Code reads `~/.claude.json` only at session startup. Quit Claude Code completely (Cmd+Q on macOS) and reopen, then re-run `/gan --print-config`."
    }
  ]
}
```

A user who has not run `install.sh` at all:

```
$ /gan --print-config
{
  "resolvedConfig": null,
  "validationErrors": [
    {
      "code": "ConfigApiUnreachable",
      "subReason": "notRegistered",
      "message": "The framework's Configuration API is not registered in this Claude Code installation. Install: `bash /Users/taa/AppForceOne/projects/ClaudeAgents/install.sh`. Then restart Claude Code."
    }
  ]
}
```

A SKILL.md section with status markers:

```markdown
## Inspection and recovery short-circuits

`--print-config` [shipped-in-v1.0]
- Calls `validateAll()` in non-aborting mode.
- Calls `getResolvedConfig()`.
- Emits an O1-shaped object on stdout.
- Exit code reflects validation status.

`--recover` [deferred-to-v1.1]
- Per O2's revision: dispatches to the recovery flow.
- v1.0 behavior: prints "this command requires v1.1; install the latest
  framework" and exits non-zero.

`--list-recoverable` [deferred-to-v1.1]
- Per O2's revision: enumerates `.gan-state/runs/*/progress.json` and prints
  recoverable runs.
- v1.0 behavior: prints "this command requires v1.1; install the latest
  framework" and exits non-zero.
```

The `gan stacks --help` output:

```
gan stacks — Inspect active or available stacks; scaffold, customize, or reset stack files.

Usage:
  gan stacks <list|available|new|where|customize|reset> [args] [--json] [--project-root DIR]

Inspect active or available stacks; scaffold, customize, or reset stack files.
  gan stacks list                       List ACTIVE stacks for this directory.
  gan stacks available                  List ALL stacks the framework ships.
  gan stacks new <name>                 Scaffold a new stub stack file.
  gan stacks where [<name>]             Show where stack files resolve from.
  gan stacks customize <name>           Copy a built-in stack into a writable tier.
  gan stacks reset <name>               Remove a customized stack copy.

  Active vs. available:
    list      = stacks whose detection rules match the current directory.
                In a project that matches one of the framework's shipped
                stacks, that stack appears here; otherwise `generic`
                (the fallback) is the active stack.
    available = every stack file the framework has on disk.
```

## Acceptance criteria

### Automated checks

- A `/gan --print-config` invocation against an installation where `~/.claude.json` lacks the `mcpServers.claudeagents-config` entry produces `ConfigApiUnreachable` with `subReason: "notRegistered"` and the install-then-restart remediation.
- A `/gan --print-config` invocation against an installation where `~/.claude.json` has the entry but the registered bin path does not exist produces `ConfigApiUnreachable` with `subReason: "binMissing"` and the re-install remediation.
- A `/gan --print-config` invocation against an installation where the entry is present, the bin exists, but the MCP server is not reachable in the current session produces `ConfigApiUnreachable` with `subReason: "notLoadedInSession"` and the restart-only remediation.
- A `/gan --recover` or `/gan --list-recoverable` invocation under v1.0 prints the documented "this command requires v1.1" message and exits non-zero.
- The `lint-status-markers` script asserts every section heading in SKILL.md has a marker (or is in a designated prologue section).
- The lint script rejects markers referencing releases not present in the roadmap (e.g. `[shipped-in-v9.9]`).
- The `gan stacks --help` output advertises all six `stacks` subcommands.
- The `gan stacks --help` output contains an "Active vs. available" paragraph distinguishing the two reads.
- The `gan stacks list` runtime output format is unchanged (one stack name per line, `(none)` on empty set; existing tests still pass).

### Manual review checks

- The `notLoadedInSession` remediation explicitly names Cmd+Q (macOS) so users don't just close the window and assume restart happened.
- All three `ConfigApiUnreachable` branches' messages obey the F4 prose-discipline rule.
- The status markers in SKILL.md align with the actual orchestrator behavior — sections marked `[shipped-in-v1.0]` are operative; sections marked `[deferred-to-v1.1]` short-circuit with a structured "requires v1.1" message.

## Dependencies

- **F2** — structured-error model; D1 adds the `subReason` discriminator on `ConfigApiUnreachable`.
- **F4** — trust prompt context; the `notRegistered` remediation may also describe the trust-prompt sequence the user will encounter on first install.
- **E1** — orchestrator that emits the diagnostics; SKILL.md status markers ride with E1's spec ownership.
- **R3** — CLI help registry; `gan stacks --help` rewrite is an R3 amendment.
- **R4** — maintainer tooling; the `lint-status-markers` script is a new R4 addition.
- **O1** — observability; `--print-config` output continues to emit `validationErrors` with the new structured fields.

## Bite-size note

Sprintable as:

1. (one sprint) `ConfigApiUnreachable` branching: orchestrator preflight check, three sub-checks, remediation routing, structured-error `subReason` discriminator.
2. (one sprint) SKILL.md status markers: token vocabulary, runtime alignment (deferred-flag short-circuits print "requires v1.1"), spec edits.
3. (one sprint) `lint-status-markers` script: parser, lint rules, CI workflow integration.
4. (one sprint) `gan stacks --help` rewrite: help registry edit, "Active vs. available" paragraph, examples update.

Slices are independent; can land in any order. Slice 3 must wait until slice 2 establishes the marker vocabulary.

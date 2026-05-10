# H1 — Framework-owned filesystem-zone enforcement hook

## Problem

The framework's PreToolUse confinement hook (`gan-confine.sh`) enforces F1's zone boundary: agents spawned by `/gan` write only inside `.gan-state/runs/<run-id>/worktree/` and the run's per-sprint artifact paths under `.gan-state/runs/<run-id>/`. Without the hook, the framework's worktree-isolation guarantee depends on agent honesty — and the framework's threat model (per F4) explicitly does not assume that.

Today the hook lives at `<project>/.claude/hooks/gan-confine.sh`. Each project that uses the framework adopted the hook by copying it from the framework's repo or authoring it from a documented snippet. The hook references the framework's filesystem zones directly:

```sh
# legacy hook content (illustrative)
if [[ "$path" == *.gan/* ]]; then
  allow
fi
```

The dogfooding session caught a downstream consequence: F1's zone rework (`.gan/` → `.gan-state/`) broke every project that had adopted the legacy hook. The hook's `*.gan/*` pattern stopped matching the new `.gan-state/runs/<id>/worktree/` path. Sprints failed mid-run with cryptic permission errors because the hook denied writes the framework expected to be allowed. Each project needed manual editing to update the path pattern, with no automated upgrade mechanism.

The structural problem: **framework filesystem decisions leak into project-tier hooks.** The framework defines zone names, paths, and structure (F1's contract); the hook enforces them. When the framework changes the contract, every downstream project that adopted the hook is silently broken until manually updated. There is no versioning, no auto-detection, no migration path — just trip-wires waiting for the next framework rework.

H1 closes this by inverting the ownership: the framework owns the hook, writes it during `install.sh`, and refreshes it on each install. Project-tier hooks remain optional overrides for projects that need narrower or wider constraints. The framework's filesystem decisions stay private to the framework — projects adopt the framework's hook unchanged.

H1 is the first spec under the **H** (framework-owned hooks) phase code. The phase is small today but anticipated to grow as more framework-owned hooks emerge (e.g. potential future SessionStart hooks for run-state hygiene, post-sprint hooks for telemetry).

## Proposed change

### User-tier hook ownership

`install.sh` writes the framework-authored confinement hook to `~/.claude/hooks/gan-confine.sh` during install. The hook's content reflects F1's current zone layout:

```sh
#!/bin/bash
# gan-confine.sh — framework-owned PreToolUse hook
# Authored by ClaudeAgents install.sh; do not edit by hand.
# Source of truth: ClaudeAgents framework, version <semver>.
# To override per-project, write a hook at <project>/.claude/hooks/gan-confine.sh.

# (hook implementation per F1's zone contract)
```

The hook is registered with Claude Code via `~/.claude/settings.json` `hooks.PreToolUse[].command` pointing at the absolute path. Same atomic-write pattern as I2's permission-allowlist merge.

**Refreshed on every `install.sh` run.** The hook's content is regenerated from the framework's current understanding of F1's zones. A user who installs an older version, then upgrades, gets the new hook content automatically. There is no "hook version" tracking; the hook is overwritten on each install. Users who want to pin to a specific version pin the framework version, not the hook independently.

**Atomic write + rollback.** The hook write goes through `install.sh`'s STATE_LOG mechanism with a new `confine-hook-written:<path>` entry. Rollback removes the hook (and its `~/.claude/settings.json` registration) if any later install step fails. Per I3's symmetric uninstall, `--uninstall` removes the hook and its registration entry.

### Hook content contract

The hook's behavior is specified, not its implementation. The implementation may be Bash, Python, Node, or any other language Claude Code's hook system supports — the install just needs to write the content in a form Claude Code can execute.

The contract:

- **Allow writes inside `.gan-state/runs/<run-id>/worktree/`** for the current run. The run-id is derived from the `GAN_RUN_ID` environment variable that the orchestrator sets at sprint start.
- **Allow writes to the run's per-sprint artifact paths** under `.gan-state/runs/<run-id>/` matching the F1-declared schema (sprint-N-contract.json, sprint-N-feedback-A.json, sprint-N-objection-A.json, sprint-N-base-commit.txt, telemetry/, trace/ — per O2's run-directory layout and T1's trace location).
- **Deny writes outside those paths** — including `~/.claude/`, `~/.claude.json`, `.claude/gan/`, `.gan-cache/`, the user's home directory generally, and any path outside the project root.
- **Deny modifications to `.gan-state/modules/`** (F1's zone-2 module-state ownership rule — module state is owned by modules, not by sprints).
- **No-op when `GAN_RUN_ID` is unset** — the hook is part of the framework's per-sprint constraint, not a global confinement. Tools invoked outside a `/gan` run are not gated by the hook.

Any future change to F1's zone layout updates the hook's content in lockstep. The hook is regenerated from a single template inside the framework's source; install.sh writes the rendered template.

### Relationship to F4's trust ladder

The confinement hook and F4's trust ladder are orthogonal layers, both load-bearing for the framework's safety story:

- **The hook (this spec) gates *where* a sprint can write.** It fires on every PreToolUse regardless of which trust rung the run is at — even a rung-5 (`unsafe-trust-all`) run is still confined to `.gan-state/runs/<run-id>/worktree/` and the run's per-sprint artifact paths. The hook's allow/deny logic does not consult the trust state.
- **F4's trust ladder gates *whether* committed project-declared commands run at all.** A rung-1 (`--no-project-commands`) run still spawns agents, still writes to the worktree, still gets confined by this hook — it just skips `evaluator.additionalChecks`, project-tier `auditCmd` / `buildCmd` / `testCmd` / `lintCmd` per F4's runtime-flag specification.

Both layers must hold for the framework's per-sprint safety guarantee. A failure of either is a failure of the guarantee. F4 documents the trust ladder; H1 documents the confinement contract; neither relies on the other for its own correctness.

### Project-tier override pattern

A project that needs different confinement (narrower OR wider) can declare its own hook at `<project>/.claude/hooks/gan-confine.sh`. Claude Code's hook resolution picks the project-tier hook over the user-tier hook when both are present. The project-tier hook is the project's responsibility — the framework does not maintain or update it, and `install.sh` does not touch it.

This mirrors C5's stack-file resolution: project tier overrides user tier overrides framework default. Most projects will not need an override; the framework hook is correct for them. Projects that need narrower constraints (e.g. additional path denials for security-sensitive directories) or wider constraints (e.g. allowing writes to a project-specific build cache) author their own.

A project with a project-tier hook gets a structured warning at install time if the user re-runs `install.sh` from inside the project's directory:

> A project-tier confinement hook is present at `.claude/hooks/gan-confine.sh`. The framework's user-tier hook at `~/.claude/hooks/gan-confine.sh` will not be used in this project. Verify the project hook still reflects the framework's current zone layout (see F1).

The warning is informational, not blocking. The project owner decides whether to keep the override or delete it.

### Migration from project-tier installs

Users with the legacy `<project>/.claude/hooks/gan-confine.sh` (referencing `.gan/`) are not silently upgraded. The legacy hook is the project's content, and the framework respects project-tier files (per C5 and the framework's own ownership boundaries). The migration path is:

1. The user runs `./install.sh`. The framework writes the new hook to `~/.claude/hooks/gan-confine.sh`.
2. The user encounters the project-tier-override warning above when running install inside the project.
3. The user inspects `<project>/.claude/hooks/gan-confine.sh`. If it's the legacy framework-content (matches the prior framework's hook bytes), the user can delete it — the framework's user-tier hook will then apply. If it's a deliberate override, the user updates it manually to reflect F1's current zones.

The framework cannot reliably distinguish "project-tier hook is a copy of the old framework hook" from "project-tier hook is a deliberate override that happens to look similar." Deletion is the user's call.

A `gan hooks status` CLI command (added in R3 by H1's implementation PR) prints the user-tier hook path, any project-tier hook in the current directory, the framework version that authored the user-tier hook, and a hint about deletion when the project-tier hook predates F1's zone rework.

### Why user-tier, not symlinked-into-project

Three options were considered for hook ownership:

- **(a) User-tier, framework-written, project-tier override.** What H1 proposes.
- **(b) Project-tier symlink** to a framework-shipped script under `<framework-install>/hooks/`. Symlinks across the project boundary recreate I1's symlink-coupling problem in a different domain — moving the framework install breaks the project's hook.
- **(c) Project-tier copy** written by `install.sh` from a template. Per-project install step (run `install.sh` inside each project), and the project-tier copy doesn't auto-update on framework upgrades.

(a) wins because the framework's hook is global to the user's machine, not per-project. There's no reason the same framework version would need different hook content per project — F1's zones are a framework-wide contract. The project-tier override exists for projects that have project-specific reasons to deviate.

### What H1 does not do

- Cover non-confinement framework hooks. If future framework hooks emerge (e.g. a SessionStart hook for run-state hygiene), they get their own H-series specs (H2, H3, …) with the same ownership pattern.
- Provide hook content for every PreToolUse / PostToolUse / SessionStart / etc. surface Claude Code exposes. H1 is specifically the confinement hook — the F1 zone enforcement.
- Provide cross-platform hook portability. The hook is Bash-flavored on macOS / Linux. Windows is out of scope per the framework's existing platform decisions.
- Migrate legacy project-tier hooks automatically. The user must explicitly delete the project-tier hook to fall back to the user-tier framework-owned hook.
- Version the hook independently from the framework. The hook content is regenerated on each install; there is no separate "hook version" tracking.

## Field encodings

H1 introduces:

- **`~/.claude/hooks/gan-confine.sh`** — framework-owned executable hook script. Path is fixed; content is regenerated on each install.
- **`~/.claude/settings.json` `hooks.PreToolUse[]` entry** — registers the hook with Claude Code. The entry's `command` field is the absolute path to the hook script. Atomic-write merge per I2's settings-edit pattern.
- **STATE_LOG entry** `confine-hook-written:<absolute-path>` — install.sh's rollback handler removes the hook on partial failure.
- **`gan hooks status` CLI command** — added to R3's command surface; reports current hook state and any project-tier overrides.

The `GAN_RUN_ID` environment variable referenced by the hook is set by the orchestrator at sprint start. Its format is the run-id pattern from O2 (`<YYYYMMDDTHHMMSS>-<4 hex>`).

## Examples

The hook content (illustrative; actual implementation may differ):

```sh
#!/bin/bash
# gan-confine.sh — ClaudeAgents PreToolUse confinement hook
# Authored by ClaudeAgents install.sh; do not edit by hand.
# Source of truth: ClaudeAgents framework, version 0.1.0.
# To override per-project, write a hook at <project>/.claude/hooks/gan-confine.sh.

set -euo pipefail

# No-op outside a /gan run.
if [ -z "${GAN_RUN_ID:-}" ]; then
  exit 0
fi

# Allow paths inside the run's worktree and per-sprint artifacts.
RUN_DIR=".gan-state/runs/${GAN_RUN_ID}"
WORKTREE="${RUN_DIR}/worktree"

# (path-matching logic per F1 zone contract)

# Deny by default outside allowed paths.
exit 1
```

A `gan hooks status` invocation in a project with a legacy override:

```
$ gan hooks status
User-tier framework hook: /Users/taa/.claude/hooks/gan-confine.sh
  Authored by ClaudeAgents 0.1.0 — current.
  Reflects F1 zone layout: .gan-state/runs/<id>/worktree/

Project-tier override: ./.claude/hooks/gan-confine.sh
  Detected. Project-tier overrides take precedence over the user-tier hook.
  This file references `.gan/` (legacy zone layout retired in v0.0.x).
  If you don't have a deliberate reason to keep this override, delete it
  (`rm .claude/hooks/gan-confine.sh`) — the framework's current user-tier
  hook will then apply.
```

## Acceptance criteria

### Automated checks

- After `./install.sh` completes, `~/.claude/hooks/gan-confine.sh` exists, is executable, and contains the F1 zone references for the framework version that ran the install.
- After `./install.sh` completes, `~/.claude/settings.json` `hooks.PreToolUse[]` includes an entry with the absolute path to the hook.
- Re-running `./install.sh` after a hypothetical F1 zone rework regenerates the hook with the new zone references.
- A simulated install where the hook write fails triggers rollback; the partial hook file and its `settings.json` registration are removed.
- `./install.sh --uninstall` removes the hook file and its `settings.json` entry.
- A `/gan` invocation in a project with no project-tier hook routes through the user-tier hook.
- A `/gan` invocation in a project with a project-tier hook routes through the project-tier hook (project tier wins).
- `gan hooks status` invoked in a project with no project-tier hook reports only the user-tier hook.
- `gan hooks status` invoked in a project with a project-tier hook detects and reports both, with a deletion hint when the project-tier hook content matches a known-legacy framework version.
- A test fixture exercising the hook against a representative path set (write inside worktree → allow; write to `~/.claude/` → deny; write to `.gan-state/modules/` → deny; write to project root outside zones → deny) produces the expected allow/deny pattern.

### Manual review checks

- The hook's content includes the "do not edit by hand" comment and references the framework version that wrote it.
- The user-tier-override warning text obeys the F4 prose-discipline rule.
- The R2 spec is updated to document the hook write as a step in `install.sh`'s sequence.
- The R3 spec is updated to document the new `gan hooks status` subcommand.
- The framework's release notes for v1.0 name the migration step for users with legacy project-tier hooks.

## Dependencies

- **F1** — zone contract. The hook's allow/deny rules are derived from F1's zone definitions.
- **F4** — threat model. The hook is the enforcement mechanism for F1's confinement guarantee; F4 describes why the guarantee matters.
- **I1** — install correctness. H1 builds on a working install pipeline.
- **I2** — install user-facing surfaces. The hook write is part of `install.sh`'s atomic-write discipline (same STATE_LOG mechanism as I2's permission-allowlist merge).
- **I3** — uninstall and version policy. Uninstall removes the hook and its registration.
- **R2** — installer spec. H1 amends R2 to include the hook-write step.
- **R3** — CLI wrapper spec. H1 adds the `gan hooks status` subcommand.

## Bite-size note

Sprintable as:

1. (one sprint) Hook content authoring: derive from F1 zones, write the script template, decide implementation language (Bash recommended for portability).
2. (one sprint) Install integration: `install.sh` writes `~/.claude/hooks/gan-confine.sh` and merges the `settings.json` registration. STATE_LOG entry. Rollback support.
3. (one sprint) Project-tier override detection + warning: install detects project-tier hooks, prints the override warning, recommends `gan hooks status` for inspection.
4. (one sprint) `gan hooks status` CLI subcommand: detect both tiers, report framework version, surface deletion hint when project-tier hook matches a legacy template.
5. (one sprint) Test coverage: hook content correctness, install / uninstall round-trip, project-tier override resolution, behavioral tests for representative path patterns.
6. (rides with R2/R3 maintenance) Update R2 and R3 spec text to reflect the new install step and CLI subcommand.

Slices 1–3 must land in order; slices 4–5 depend on 1–3 and can land in parallel; slice 6 lands with the spec revisions in the same PR as slices 4 / 5.

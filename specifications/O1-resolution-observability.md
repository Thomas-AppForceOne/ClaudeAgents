# O1 — Resolution observability

## Problem

Once stack dispatch (C2), overlays (C3, C4), and three-tier resolution (C5) are in place, it becomes hard for a user to answer "why did `/gan` do that?" — which stacks were active, which tier each stack came from, which overlay fields applied, which `additionalContext` files were read. Debugging a misbehaving run without this is guesswork.

> **Status markers (per [D1](D1-diagnostic-clarity.md)).** Both O1 surfaces are operative in v1.0: the SKILL.md `/gan --print-config` flag-parsing section carries `[shipped-in-v1.0]` (D1's worked example uses exactly this flag), and the orchestrator startup-log section (part A) likewise. No part of O1 is deferred, so D1's `lint-status-markers` — which requires every SKILL.md section heading to carry a marker — passes for O1's additions once they land.

## Proposed change

Two mechanisms — one automatic, one on demand. Both surface data the Configuration API (F2) already produces; this spec defines how that data reaches the user.

**A. Startup log line (automatic, every run)**

The skill orchestrator, after `validateAll()` succeeds and before spawning agents, prints a single structured record summarising the resolved config it captured from `getResolvedConfig()`:

```
/gan loaded:
  stacks: web-node (project)
  user overlay: ~/.claude/gan/user.md  (loaded)
  project overlay: .claude/gan/project.md  (loaded)
  additionalContext: docs/architecture.md, docs/conventions.md
  discarded: proposer.additionalCriteria, generator.additionalRules
```

The `discarded` line is the resolved config's `discarded` field verbatim — the shipped `string[]` of dotted `block.field` names where some tier set `discardInherited: true` (`CascadeResult.discarded`, `src/config-server/resolution/cascade.ts:196`). It does **not** carry per-tier origin or replacement detail (the cascade collapses that to a boolean and does not record it); richer discard provenance would be a future *resolver* change, out of O1's surface-what-exists scope.

Missing sources are listed explicitly (`(none)`), not silently omitted — "nothing loaded" is also useful information.

Tier labels in the startup line and in `--print-config` JSON are the canonical [`project` / `user` / `builtin`](C5-stack-file-resolution.md) set per C5 — **already the shipped resolution labels** (`ResolvedStackEntry.tier` is `'project' | 'user' | 'builtin'`, `resolved-config.ts`); O1 introduces no tier-label change (there is no `repo` label left in the resolution code to retire).

The orchestrator owns this line because it owns the snapshot. Spawned agents do not re-emit their own loaded-files line; they consume the snapshot the orchestrator captured (per F2's validation timing).

**B. `gan config print` and the `/gan --print-config` flag**

Two equivalent surfaces for the same data:

- `gan config print` (R3) is the human/script entry point. It calls `getResolvedConfig()` and prints the result.
- `/gan --print-config` is the Claude Code skill's flag. It runs `validateAll()` + `getResolvedConfig()` and prints the result without creating a worktree or spawning sprint agents.

Both produce identical JSON when given `--json`. The flag parsing for `/gan --print-config` lives in SKILL.md alongside `--recover` / `--list-recoverable` from O2; this spec does not re-home flag parsing.

**Failure mode: fail-open.** `--print-config` is a debug surface. When `validateAll()` fails, it still prints the **partial resolved config** — the same flat `getResolvedConfig()` shape `gan config print` emits, whose own `issues` and `warnings` arrays *are* the structured validation report (the resolver returns them as fields of the resolved object — `ResolvedConfig.issues: Issue[]`, `ResolvedConfig.warnings: Warning[]`, `src/config-server/resolution/resolved-config.ts:89,91`). There is **no** separate `validationErrors`/`resolvedConfig` wrapper — that would diverge from the shipped flat shape and break the byte-identical-with-`gan config print` AC; the validation results live in the resolved object's `issues`/`warnings`. Exit code reflects validation status (non-zero on any error-severity issue), but the user always gets the resolved view. This differs from a regular `/gan` run, which fails closed and prints only the validation report.

**Exit code policy on warnings (v1.0).** The resolver's `issues` carry a `severity` (`'error' | 'warning'`, `validate.ts`) and the separate `warnings: Warning[]` array holds the W1 family (e.g. `StackOverrideShrinkage`). `--print-config`'s exit code is:

- **0** — no error-severity issue. Warning-severity `issues` and any `warnings` are present in the resolved object and enumerated to stderr in non-JSON mode; the default exit-zero matches "warnings inform, errors fail." CI scripts that gate on warnings inspect `issues[].severity === "warning"` / a non-empty `warnings`.
- **Non-zero** — one or more error-severity `issues`. The exit code is the same regardless of whether warnings are also present.

A build that wants to fail on any warning passes `--strict-warnings` (added in v1.1's `gan` CLI work, not v1.0). For v1.0, warnings are exit-0 and CI scripts that care write a separate check.

The output:

```json
{
  "apiVersion": "0.1.0",
  "schemaVersions": { "stack": 1, "overlay": 1 },
  "runtimeMode": { "noProjectCommands": false },
  "stacks": {
    "active": ["web-node"],
    "byName": {
      "web-node": { "tier": "project", "path": ".claude/gan/stacks/web-node.md", "schemaVersion": 1 }
    }
  },
  "overlay": { "...": "the cascade-resolved overlay Record (C3 splice points, merged per C4)" },
  "discarded": ["proposer.additionalCriteria", "generator.additionalRules"],
  "additionalContext": {
    "planner":  [{ "path": "docs/architecture.md", "exists": true }],
    "proposer": [{ "path": "docs/pr-checklist.md", "exists": false }]
  },
  "issues": [],
  "warnings": [],
  "modules": { "docker": { "...": "resolved module entry" } }
}
```

This is the **shipped flat `getResolvedConfig()` shape verbatim** (`src/config-server/resolution/resolved-config.ts:76-101`) — the same object `gan config print --json` already emits and the snapshot SKILL.md forwards to agents; O1's slot-mate O3 shows the same shape. The shape is stable so users and CI can diff configs across branches.

- **`overlay`** is the cascade-resolved overlay `Record` (C3 defines the splice-point keys — `proposer.additionalCriteria`, `evaluator.additionalChecks`, etc.; C4 the merge rules). It is **not** a separate `mergedSplicePoints` top-level key; any new C3 splice point appears here with no O1 edit. (`getMergedSplicePoints` is a *separate* read tool, not this object.)
- **`discarded`** is the shipped **`string[]`** of dotted `block.field` names where some tier set `discardInherited: true` (`cascade.ts:196,245`). It records *what* was discarded; it does **not** carry per-tier origin or a `replacedWith` shape — the cascade collapses that to a boolean (`everDiscarded`) and does not retain it. Per-tier/replacement provenance is a *future resolver* enhancement (a `discarded`-shape change), out of O1's surface-what-exists scope; the merged replacement value is already visible in `overlay`, so a debugger reads "field X was discarded" from `discarded` and "what replaced it" from `overlay.X`.
- **`additionalContext`** rows are the shipped `{ path, exists }` shape (`resolved-config.ts:125-128`); `exists: false` is the missing-file marker (the human renderer must surface it, not drop it).
- **`issues`** / **`warnings`** are the resolver's validation arrays (error/warning-severity issues; the W1 `Warning` family) — see the fail-open exit-code policy above.

## Acceptance criteria

- The skill orchestrator's startup log lists exactly the files reflected in the resolved config it received from `getResolvedConfig()`; no silent omissions.
- `gan config print` and `/gan --print-config` produce byte-identical JSON output (with `--json`) for the same project state.
- Running `/gan --print-config` does not create a worktree, spawn sprint agents, or write to zone 2.
- A missing file in `additionalContext` shows as a row with `exists: false` (the missing-file marker — the shipped `{path, exists}` row shape); the human renderer surfaces it rather than dropping the row.
- Running `--print-config` on a repo with no overlays produces a valid JSON document with an empty `overlay` object, stacks resolved from detection, and an empty `discarded` array (`[]`).
- A project overlay declaring `proposer.discardInherited: true` plus its own `proposer.additionalCriteria: [a, b]` makes `discarded` contain the string `"proposer.additionalCriteria"`, and the resolved `[a, b]` appears under `overlay.proposer.additionalCriteria` (what replaced it is read from `overlay`, not a `replacedWith` field — which the shipped resolver does not produce).
- A field-level discard like `generator.additionalRules.discardInherited: true` with no replacement makes `discarded` contain the string `"generator.additionalRules"`, with no `overlay.generator.additionalRules` value present (it fell back to the agent default).
- Running `/gan --print-config` against a project with a malformed overlay prints the partial resolved config (the flat `getResolvedConfig()` shape) whose `issues` array carries the error-severity validation results; exit code is non-zero. (Fail-open behaviour, distinct from a regular `/gan` run, which prints only the validation report.)

## Version bump (install-affecting)

O1 changes `gan config print`'s fail-open behaviour (the partial resolved view plus the `validationErrors` / `validationWarnings` keys) and its exit-code policy — a CLI/server (installed-package) change that takes effect only via `install.sh`'s version-gated `npm install -g .`. Per the pre-1.0 install-version bump discipline (roadmap § "Pre-release chores and release gate"), O1's implementation PR **minor-bumps `package.json` `version`** (`0.MINOR.0`). (The `--print-config` flag parsing and the startup-log line live in `SKILL.md`, copied every install; the bump is for the `gan config print` package change.) **O3 ships in the same slot (21) and also minor-bumps** — if O1 and O3 land in one PR that is a single coordinated bump; if separate PRs, the second out-numbers the first.

## Dependencies

- F2 (the API that produces the data this spec surfaces)
- R1 (reference implementation of that API)
- R3 (`gan config print` lives here)
- C2, C3, C4, C5 (the resolution layers being made observable)

## Note on the E1 coordination (already satisfied)

The startup-log mechanism relies on the orchestrator (SKILL.md) being the single point that captures and forwards the resolved snapshot, with agents consuming it. **That coordination is shipped, not pending:** E1 (the agent-prompt rewrite) has merged — the agents consume the captured snapshot / `getResolvedConfig()` rather than re-loading config (SKILL.md § "Spawn discipline"; the retired per-agent config-reads are recorded in `specifications/retirements.md`). So the "orchestrator captures, agents consume" model O1's startup line assumes is already in force. O1 adds only the orchestrator-level startup line; per-agent loaded-files lines are not re-introduced (obsolete under the captured-snapshot model). (E1 is therefore a *shipped* predecessor, not a gating dependency — it is not in the Dependencies list above because there is nothing left to wait on.)

## Bite-size note

Sprint slices: **extend the shipped `gan config print`** (R3 — add fail-open + the exit-code policy; it already emits the flat `getResolvedConfig()` shape, so this is a behaviour change to shipped code, not net-new) → `/gan --print-config` flag in SKILL.md → orchestrator startup log → surface the existing `discarded` `string[]`. Each is independently testable.

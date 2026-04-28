# O1 — Resolution observability

## Problem

Once stack dispatch (C2), overlays (C3, C4), and three-tier resolution (C5) are in place, it becomes hard for a user to answer "why did `/gan` do that?" — which stacks were active, which tier each stack came from, which overlay fields applied, which `additionalContext` files were read. Debugging a misbehaving run without this is guesswork.

## Proposed change

Two mechanisms — one automatic, one on demand. Both surface data the Configuration API (F2) already produces; this spec defines how that data reaches the user.

**Phase carve-out.** Per the roadmap, part A (the startup log line) lands in R1's Phase 2 work as the framework's minimum-viable observability surface — Phase 5 stack authors need at least the "which files were loaded, which stacks are active" view before O1's full suite lands in Phase 6. Part B and the richer surfaces below (`gan config print`, `--print-config` JSON, the `discarded` array, the `replacedWith` field) remain O1 / Phase 6 work. This spec documents both halves; the implementation lands in two stages.

**A. Startup log line (automatic, every run) — lands with R1 in Phase 2**

The skill orchestrator, after `validateAll()` succeeds and before spawning agents, prints a single structured record summarising the resolved config it captured from `getResolvedConfig()`:

```
/gan loaded:
  stacks: android.md (project), web-node.md (repo)
  user overlay: ~/.claude/gan/config.md
  project overlay: .claude/gan/project.md
  additionalContext: docs/architecture.md, docs/conventions.md
  discarded: proposer (by project), generator.additionalRules (by user)
```

Missing sources are listed explicitly (`(none)`), not silently omitted — "nothing loaded" is also useful information.

The orchestrator owns this line because it owns the snapshot. Spawned agents do not re-emit their own loaded-files line; they consume the snapshot the orchestrator captured (per F2's validation timing).

**B. `gan config print` and the `/gan --print-config` flag — lands in Phase 6 (this spec's main scope)**

Two equivalent surfaces for the same data:

- `gan config print` (R3) is the human/script entry point. It calls `getResolvedConfig()` and prints the result.
- `/gan --print-config` is the Claude Code skill's flag. It runs `validateAll()` + `getResolvedConfig()` and prints the result without creating a worktree or spawning sprint agents.

Both produce identical JSON when given `--json`. The flag parsing for `/gan --print-config` lives in SKILL.md alongside `--recover` / `--list-recoverable` from O2; this spec does not re-home flag parsing.

**Failure mode: fail-open.** `--print-config` is a debug surface. When `validateAll()` fails, the output prints both the partial resolved view (everything the resolver could compute despite the errors) **and** the structured error report. Both are JSON when `--json` is given; both surfaces are top-level keys in the output (`resolvedConfig` and `validationErrors`). Exit code reflects the validation status (non-zero on failure), but the user always gets the resolved view to debug from. This differs from a regular `/gan` run, which fails closed and prints only the validation report.

The output:

```json
{
  "apiVersion": 1,
  "activeStacks": [
    {"name": "android", "tier": "project", "path": ".claude/gan/stacks/android.md", "schemaVersion": 1},
    {"name": "web-node", "tier": "repo",    "path": "stacks/web-node.md",          "schemaVersion": 1}
  ],
  "overlays": {
    "user":    {"loaded": true, "path": "~/.claude/gan/config.md"},
    "project": {"loaded": true, "path": ".claude/gan/project.md"}
  },
  "mergedSplicePoints": {
    "proposer.additionalCriteria": [/* … */],
    "evaluator.additionalChecks": [/* … */],
    "runner.thresholdOverride": 9
  },
  "discarded": [
    {"scope": "proposer",                        "byTier": "project", "replacedWith": "2 entries"},
    {"scope": "generator.additionalRules",       "byTier": "user",    "replacedWith": "empty"}
  ],
  "additionalContext": {
    "planner":  ["docs/architecture.md"],
    "proposer": ["docs/pr-checklist.md"]
  }
}
```

The JSON shape is stable so users and CI can diff configs across branches or environments. The shape is exactly what `getResolvedConfig()` returns from F2.

Splice-point keys (`proposer.additionalCriteria`, `evaluator.additionalChecks`, `runner.thresholdOverride`, etc.) are **not** defined in this spec — they are authoritatively defined in C3. This spec's `mergedSplicePoints` object simply reports the cascade-resolved result per C4's merge rules. Any new splice point added in a future C3 revision automatically appears here with no edit required.

The `discarded` array reports every block or field where `discardInherited: true` was applied during resolution. Each entry names:

- `scope` — the block (e.g. `proposer`) or specific field (e.g. `generator.additionalRules`) that was discarded.
- `byTier` — the tier that declared the discard (`user` or `project`).
- `replacedWith` — what the discarding tier provided instead. Either `"empty"` (the tier discarded but provided no replacement, so the field is now empty / at agent default) or `"<N> entries"` for list fields, or `"<value>"` for scalar fields. This makes "why is this value missing?" answerable without further inspection.

The combination tells a debugger both *what* was discarded and *what replaced it*.

## Acceptance criteria

- The skill orchestrator's startup log lists exactly the files reflected in the resolved config it received from `getResolvedConfig()`; no silent omissions.
- `gan config print` and `/gan --print-config` produce byte-identical JSON output (with `--json`) for the same project state.
- Running `/gan --print-config` does not create a worktree, spawn sprint agents, or write to zone 2.
- A missing file in `additionalContext` shows up in both surfaces with a clear "missing" marker.
- Running `--print-config` on a repo with no overlays produces a valid JSON document with every source marked not-loaded and an empty `discarded` array.
- A project overlay declaring `proposer.discardInherited: true` plus its own `proposer.additionalCriteria: [a, b]` appears in the `discarded` array as `{"scope": "proposer", "byTier": "project", "replacedWith": "2 entries"}`.
- A field-level discard like `generator.additionalRules.discardInherited: true` with no replacement appears as `{"scope": "generator.additionalRules", "byTier": "<tier>", "replacedWith": "empty"}`.
- Running `/gan --print-config` against a project with a malformed overlay prints both the partial resolved view (under `resolvedConfig`) and the validation errors (under `validationErrors`); exit code is non-zero. (Fail-open behavior, distinct from a regular `/gan` run.)

## Dependencies

- F2 (the API that produces the data this spec surfaces)
- R1 (reference implementation of that API)
- R3 (`gan config print` lives here)
- C2, C3, C4, C5 (the resolution layers being made observable)

## Note on E1 dependency

The startup-log mechanism described under part A relies on the orchestrator (SKILL.md) being the single point that captures and forwards the resolved snapshot, with agents consuming it instead of re-loading. That coordination is finalised by E1 (agent prompt rewrite). Until E1 lands, agents may still read configuration directly; the startup log can ship at the orchestrator level immediately, but per-agent log lines should not be re-introduced — they are obsolete under F2's "orchestrator captures, agents consume" model.

## Bite-size note

Sprint slices: `gan config print` (R3 already drafts this) → `/gan --print-config` flag in SKILL.md → orchestrator startup log → `discarded` array surfacing. Each is independently testable.

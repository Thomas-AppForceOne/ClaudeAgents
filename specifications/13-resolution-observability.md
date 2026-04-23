# 13 — Resolution observability

## Problem

Once stack dispatch (05), overlays (09, 11), and three-tier resolution (12) are in place, it becomes hard for a user to answer "why did `/gan` do that?" — which stacks were active, which tier each stack came from, which overlay fields applied, which `additionalContext` files were read. Debugging a misbehaving run without this is guesswork.

## Proposed change

Two mechanisms — one automatic, one on demand:

**A. Startup log line (automatic, every run)**

Each agent, as its first visible output, prints a single structured record naming every file it loaded, in order:

```
[gan-planner] loaded:
  stacks: android.md (project), web-node.md (repo)
  user overlay: ~/.claude/gan/config.md
  project overlay: .claude/gan/project.md
  additionalContext: docs/architecture.md, docs/conventions.md
```

Missing sources are listed explicitly (`(none)`), not silently omitted — "nothing loaded" is also useful information.

**B. `--print-config` flag**

Parsed by the `/gan` skill at its argument-parsing step, alongside the `--recover` / `--list-recoverable` flags defined in `gan-recover.md`. All top-level `/gan` flags are defined in a single table in SKILL.md; this spec does not re-home flag parsing.

Resolves everything without running a sprint and prints a single JSON document:

```json
{
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
    {"scope": "proposer",                        "byTier": "project"},
    {"scope": "generator.additionalRules",       "byTier": "user"}
  ],
  "additionalContext": {
    "planner":  ["docs/architecture.md"],
    "proposer": ["docs/pr-checklist.md"]
  }
}
```

The JSON is stable (documented) so users and CI can diff configs across branches or environments.

Splice-point keys (`proposer.additionalCriteria`, `evaluator.additionalChecks`, `runner.thresholdOverride`, etc.) are **not** defined in this spec — they are authoritatively defined in spec 09 (project overlay) and spec 11 (user overlay). This spec's `mergedSplicePoints` object simply reports the result of merging the overlays per those specs' semantics. Any new splice point added in a future spec 09/11 revision automatically appears here with no edit required.

The `discarded` array reports every block or field where `discardInherited: true` was applied during resolution. Each entry names the scope that was discarded (a block like `proposer`, or a specific field like `generator.additionalRules`) and the tier that declared the discard (`user` or `project`). This lets a debugger see at a glance why an upstream value failed to reach the final merged config.

## Acceptance criteria

- Every agent's startup log lists exactly the files it loaded; no silent omissions.
- `gan --print-config` runs without creating a worktree or invoking subagents, and prints valid JSON conforming to a documented schema.
- A missing file in `additionalContext` shows up in both the startup log and the `--print-config` output with a clear "missing" marker.
- Running `--print-config` on a repo with no overlays at all produces a valid JSON document with every source marked not-loaded and an empty `discarded` array.
- A project overlay declaring `proposer.discardInherited: true` appears in `--print-config`'s `discarded` array as `{"scope": "proposer", "byTier": "project"}`.
- A field-level discard like `generator.additionalRules.discardInherited: true` appears as `{"scope": "generator.additionalRules", "byTier": "<tier>"}`.

## Dependencies

- 05, 09, 11, 12 (this is the debugging layer for all of them).

## Value / effort

- **Value**: high once resolution complexity exists. Without it, every support request starts with "I don't know what it loaded."
- **Effort**: small-medium. The startup log is trivial; `--print-config` is mostly a plumbing refactor so the resolution logic can run standalone without side effects.

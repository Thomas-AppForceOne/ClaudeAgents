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

**B. `gan --print-config` flag**

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
  "additionalContext": {
    "planner":  ["docs/architecture.md"],
    "proposer": ["docs/pr-checklist.md"]
  }
}
```

The JSON is stable (documented) so users and CI can diff configs across branches or environments.

## Acceptance criteria

- Every agent's startup log lists exactly the files it loaded; no silent omissions.
- `gan --print-config` runs without creating a worktree or invoking subagents, and prints valid JSON conforming to a documented schema.
- A missing file in `additionalContext` shows up in both the startup log and the `--print-config` output with a clear "missing" marker.
- Running `--print-config` on a repo with no overlays at all produces a valid JSON document with every source marked not-loaded.

## Dependencies

- 05, 09, 11, 12 (this is the debugging layer for all of them).

## Value / effort

- **Value**: high once resolution complexity exists. Without it, every support request starts with "I don't know what it loaded."
- **Effort**: small-medium. The startup log is trivial; `--print-config` is mostly a plumbing refactor so the resolution logic can run standalone without side effects.

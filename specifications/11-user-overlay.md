# 11 — User overlay file

## Problem

Some preferences are personal and cross-project: a user always wants `--threshold 8`, always disables telemetry, always prefers a specific base branch naming convention, always wants `detekt` run as an additional evaluator check. Forcing these into every project's `.claude/gan/project.md` creates repetition and bleeds personal choices into shared config that may be committed to the repo.

## Proposed change

Add a user-scoped overlay: `~/.claude/gan/config.md`. Same schema as the project overlay (spec 09), different precedence:

- **Default** < user overlay < project overlay.
- User overlay is loaded once per run, before the project overlay.
- Project overlay fields override user overlay fields with the same key; additive fields (like `proposer.additionalCriteria`) are concatenated with user entries first.

Rules:

- Identical splice points to 09. No user-only or project-only fields — the schema is one schema.
- User overlay never reads files via `additionalContext` (those paths are project-relative; user-level context makes no sense).
- Missing user overlay is a no-op.

## Acceptance criteria

- With only a user overlay setting `runner.thresholdOverride: 8`, every project run uses threshold 8.
- With a user overlay setting threshold 8 and a project overlay setting threshold 9, the project runs with threshold 9.
- With a user overlay adding criterion `A` and a project overlay adding criterion `B`, every contract contains both (order: user first, project second).
- Referencing `additionalContext` in the user overlay produces a hard error at load time.

## Dependencies

- 09.

## Value / effort

- **Value**: medium. Quality-of-life for power users; unlocks the auto-memory integration path (a user's memory system can populate this file without touching ClaudeAgents internals).
- **Effort**: small — reuses the 09 loader with a different path and precedence pass.

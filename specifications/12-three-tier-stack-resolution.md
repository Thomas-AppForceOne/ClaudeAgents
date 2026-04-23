# 12 — Three-tier stack resolution

## Problem

Even with a stack plugin system (04/05) and overlays (09/11), a user may need to **customise a stack itself** for one project — tighten the Android `securitySurfaces` catalog with company-specific rules, adjust the `runCmd` to invoke an in-house wrapper. Today spec 06 only resolves stacks from the repo directory; there is no way to shadow a built-in stack without editing the repo.

## Proposed change

Extend stack-file resolution to three tiers, highest priority first:

1. `.claude/gan/stacks/<name>.md` — project-specific.
2. `~/.claude/gan/stacks/<name>.md` — user-personal.
3. `<repo>/stacks/<name>.md` — built-in defaults shipped with ClaudeAgents.

Resolution rules:

- For each **active stack name** (as determined by detection in spec 05), load the file from the highest-priority tier that contains it.
- A project tier file **replaces** the lower-tier file for that stack — no partial merging. Replacement is coarse but predictable; users who want additive behavior should use overlays (09), not shadow the stack file.
- `schemaVersion` in the stack file frontmatter must match what the loaded agent understands; mismatch is a hard error.
- The loader records which tier each active stack came from for later observability (spec 13).

Detection rules live only in tier 3 (built-in) for v1 — project tiers can override a stack's contents but not introduce new detection patterns. This keeps the detection surface auditable. If a user needs a completely new stack, they put a file in a project tier and force it via `stack.override` (from spec 09).

## Acceptance criteria

- Dropping `.claude/gan/stacks/android.md` in a project causes that file to be loaded instead of the repo's `stacks/android.md`, verifiable via the observability output from spec 13.
- A user-level stack file is loaded when no project-level file exists and no repo-level file exists for that name.
- A `schemaVersion` mismatch produces a hard error naming the offending file and the expected version.
- Removing the project-level file restores repo defaults without further action.

## Dependencies

- 04, 05, 09 (for `stack.override` interaction), 11 (for the user tier).

## Value / effort

- **Value**: medium. Power-user feature, but essential for organisations with internal security baselines they want to apply across many projects.
- **Effort**: small-medium. Mostly plumbing in the stack loader plus careful documentation of the "replacement, not merge" rule.

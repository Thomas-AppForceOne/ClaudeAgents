# C5 — Three-tier stack file resolution

## Problem

Even with the stack plugin system (C1/C2) and overlays (C3/C4), a user may need to **customise a stack itself** for one project — tighten the Android `securitySurfaces` catalog with company-specific rules, point a `buildCmd` at an in-house wrapper. Without per-tier resolution, stack content can only be changed by editing the framework repo.

## Proposed change

Extend stack-file resolution to three tiers, highest priority first:

1. `.claude/gan/stacks/<name>.md` — project-specific. Zone 1 (config) per [spec F1](F1-filesystem-layout.md); user-authored and committed.
2. `~/.claude/gan/stacks/<name>.md` — user-personal.
3. `<repo>/stacks/<name>.md` — built-in defaults shipped with ClaudeAgents.

The resolution runs **inside the Configuration API** (F2) — specifically inside R1's stack loader. Agents call `getStack()` / `getActiveStacks()` and receive the resolved file's data; they never enumerate tiers themselves.

Resolution rules:

- For each **active stack name** (per C2's detection algorithm), the API serves the file from the highest-priority tier that contains it.
- A project tier file **replaces** the lower-tier file for that stack — no partial merging. Replacement is coarse but predictable; users who want additive behavior should use overlays (C3), not shadow the stack file.
- **Replacement is wholesale.** A project-tier `stacks/docker.md` that omits a `pairsWith` declaration drops the pairing — even if the repo-tier file declared one. If the user wants the pairing preserved, they must re-declare `pairsWith` in their project-tier file. The `pairs-with.js` invariant fires on any inconsistency between the resolved (highest-priority) stack file's `pairsWith` and the corresponding module's manifest.
- `schemaVersion` in the stack file frontmatter must exactly match the API's known stack schema version; mismatch is a hard `SchemaMismatch` error.
- The API records which tier each active stack came from and exposes it via `getResolvedConfig()` for O1's observability surface.

Detection rules live only in tier 3 (built-in) for v1 — project tiers can override a stack's contents but not introduce new detection patterns. This keeps the detection surface auditable. If a user needs a completely new stack, they put a file in a project tier and force it via `stack.override` (from spec C3).

## Acceptance criteria

- Dropping `.claude/gan/stacks/android.md` in a project causes that file to be loaded instead of the repo's `stacks/android.md`, verifiable via the observability output from spec O1.
- A user-level stack file is loaded when no project-level file exists and no repo-level file exists for that name.
- A `schemaVersion` mismatch produces a hard error naming the offending file and the expected version.
- Removing the project-level file restores repo defaults without further action.

## Dependencies

- C1, C2 (the dispatch algorithm whose results this resolves)
- C3 (for `stack.override` interaction), C4 (for the user tier)
- F2 (resolution runs inside the API)

R1 implements the resolution; the dependency runs from R1 to C5, not the reverse.

## Bite-size note

One resolver function inside R1's stack loader. Sprintable in three slices: tier enumeration → project-replaces-lower replacement logic → tier provenance reporting for O1. Each is independently testable against fixtures with stack files at varying tiers.

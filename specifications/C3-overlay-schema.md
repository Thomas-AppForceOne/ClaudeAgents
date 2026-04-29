# C3 — Overlay schema

## Problem

Projects and users need to adjust `/gan` behavior without forking agents or stack files: add a criterion that always applies, force a stack in a polyglot repo, tighten a threshold. C3 defines the *schema* of the overlay files that carry these adjustments. The cascade across tiers lives in C4; the human-side experience lives in U1 (project) and U2 (user).

## Proposed change

Two overlay files share one schema:

- **Project overlay:** `.claude/gan/project.md`. Zone 1 (config) per F1; committed to the repo.
- **User overlay:** `~/.claude/gan/config.md`. Outside any project; user-personal.

Both follow the same parse contract and field set. The only differences are the file location, the cascade tier they sit at (defined in C4), and a per-field rule that some splice points are forbidden in the user overlay (`additionalContext` keys).

## Parse contract

Same as stack files (per C1): YAML frontmatter with `schemaVersion`, then a single canonical YAML body block. Markdown prose outside the YAML block is human-only and never read for semantic content.

```
---
schemaVersion: 1
---

```yaml
stack:
  override:
    - android
    - kmp

proposer:
  additionalCriteria:
    - name: no_new_kapt
      description: No new `kapt` annotation processors introduced; prefer KSP.
      threshold: 9

generator:
  additionalRules:
    - "Do not introduce new reflection-based DI frameworks."

evaluator:
  additionalChecks:
    - command: "./gradlew detekt"
      on_failure: blockingConcern

runner:
  thresholdOverride: 8
```
```

## Splice-point catalog (authoritative)

This table is the **single source of truth** for every overlay splice point — its shape, its default, its tier-allowance, and its merge rule across the cascade. Other specs (C4 for cascade narrative, O1 for `mergedSplicePoints`, U1 / U2 for UX) reference this catalog rather than restating it. Adding a new splice point means editing this table and (if applicable) C4's narrative — never editing UX prose to keep specs consistent.

**Design assumption: splice points resolve independently.** Each splice point's resolved value is computed from its own per-tier values plus its merge rule. There are no cross-splice-point conditional rules ("use stack X's threshold unless stack Y is also active"). If a future splice point requires that, it would not fit this catalog's shape and would need its own spec section justifying the deviation. Today, all splice points are independent.

| Path | Shape | Default | Allowed in user overlay | Merge rule (default → user → project) |
|---|---|---|---|---|
| `stack.override` | list of stack names | `[]` | **No** (per-rationale below) | Project-only; user value rejected at load |
| `stack.cacheEnvOverride` | map `<stack-name> → <envVar> → <valueTemplate>` | `{}` | Yes | Deep merge; project key wins on duplicate. Lets a project override one envVar of one stack without replacing the whole stack file. Resolves the cacheEnv conflict scenario in C1. |
| `proposer.additionalCriteria` | list of `{name, description, threshold}` | `[]` | Yes | Union, keyed by `name`. Higher tier wins on duplicate. |
| `proposer.suppressSurfaces` | list of `<stack>.<surface-id>` strings | `[]` | Yes | Union, dedup by exact string. A surface listed here is dropped from `proposer.additionalCriteria`'s effective output even if its stack is active. Lets a project mute one auto-instantiated surface without forking the entire stack file. |
| `proposer.additionalContext` | list of file paths (per U3) | `[]` | **No** (paths are project-relative) | Project-only |
| `planner.additionalContext` | list of file paths (per U3) | `[]` | **No** (paths are project-relative) | Project-only |
| `generator.additionalRules` | list of strings | `[]` | Yes | Union, dedup by exact string |
| `evaluator.additionalChecks` | list of `{command, on_failure}` | `[]` | Yes | Union, keyed by `command`. Higher tier wins on duplicate. Execution order = merge order. |
| `runner.thresholdOverride` | integer | agent's baked-in threshold | Yes | Higher tier wins if defined |

**User-overlay forbidden fields.** A user overlay declaring `additionalContext`, `stack.override`, or `stack.cacheEnvOverride` is a hard error at load time per F2's structured error model. The reasoning differs:
- `additionalContext`: paths are project-relative and meaningless at user scope.
- `stack.override`: per C2, any non-empty value replaces auto-detection. A user-tier value silently disables auto-detection in every project the user touches — almost never the intent.
- `stack.cacheEnvOverride`: targets a specific stack's `cacheEnv`; the right value depends on the project's worktree paths and tooling, not the user's preference.

**`stack.cacheEnvOverride` example.**

```yaml
stack:
  cacheEnvOverride:
    gradle:
      GRADLE_USER_HOME: "<worktree>/.gan-cache/our-shared-gradle"
    web-node:
      PNPM_HOME: "<worktree>/.gan-cache/pnpm-pinned"
```

This lets a polyglot project resolve a `cacheEnv` collision (per C1's "Conflict resolution" rule) by overriding one envVar's `valueTemplate` without copying an entire stack file into `.claude/gan/stacks/`. The final `cacheEnv` for each stack is computed by deep-merging the override into the stack file's declared `cacheEnv`.

## `discardInherited`

Either overlay may declare `discardInherited: true` to discard upstream values before applying its own.

**Block-level** — flag sits alongside the splice points inside a block:

```yaml
proposer:
  discardInherited: true     # drop every upstream proposer.* value
  additionalCriteria:
    - name: company_only
      threshold: 10
```

**Field-level** — wrap the field's value as `{ discardInherited: true, value: <original-value> }`:

```yaml
generator:
  additionalRules:
    discardInherited: true
    value:
      - "Company-only rule set, not merged with user defaults."
```

Rules:

- Allowed at both user and project overlay levels. User-level discard targets the agent-baked defaults; project-level discard targets the user-resolved view (which already includes the defaults).
- Omitted = follow normal merge semantics (per C4).
- `discardInherited: false` is valid and equivalent to omission. Useful for overriding a block-level `true` on a single field.
- A field-level `discardInherited: false` inside a block whose `discardInherited: true` is set wins for that specific field — the rest of the block is still discarded. More-specific wins.
- `discardInherited: true` without a replacement value is allowed; the field resets to its default.
- An unknown field-level wrapper (a `{discardInherited, value}` shape on a field that doesn't accept the structured form) is a hard error.

## Validation rules

- `schemaVersion` must exactly match the API's known overlay schema version (per F3). Mismatch is a `SchemaMismatch` error.
- Unknown splice-point keys are hard errors. The error includes a similar-name suggestion when the key is close to a known one (per U1's error UX).
- `additionalContext` in a user overlay is a hard error.
- `discardInherited` values that are not strict booleans are hard errors.

## Acceptance criteria

- An overlay declaring every legal field validates successfully against `schemas/overlay-vN.json`.
- An overlay with an unknown key fails validation with the offending key cited in the error.
- A user overlay declaring `proposer.additionalContext` fails validation with a clear message.
- A field-level `discardInherited: false` inside a block with `discardInherited: true` is honored: the surrounding block is discarded, that one field is merged.
- The schema document `schemas/overlay-vN.json` is the authoritative source of truth; the prose in this spec is illustrative.

## Dependencies

- F2 (API contract), F3 (schema authority)
- C1 (parse contract reused)

C4 (cascade) builds on this spec, not the other way around. C4 is referenced throughout for merge semantics but is authored after C3.

## Bite-size note

This spec covers schema and validation only. The cascade lives in C4; project UX in U1; user UX in U2; `additionalContext` semantics in U3. Each can land independently.

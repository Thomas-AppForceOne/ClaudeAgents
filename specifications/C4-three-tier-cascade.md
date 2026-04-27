# C4 — Three-tier overlay cascade

## Problem

Configuration values flow through three tiers (default, user, project), each potentially contributing to the final value an agent sees. Without a declared cascade, the resolution rules per splice point are ambiguous: do lists concatenate or replace? Does a project value override a user value, or vice versa? What happens with duplicate entries? This spec pins those rules so the resolver in R1 has a single authoritative reference.

## Cascade

Three levels, from most general to most specific:

1. **Defaults** — baked into the agent. Always present. Per-field default values listed in spec C3's splice-point table.
2. **User overlay** (`~/.claude/gan/config.md`) — personal preferences, cross-project. Optional. UX in U2.
3. **Project overlay** (`.claude/gan/project.md`) — per-project adjustments. Optional. UX in U1.

Each level merges into the resolved view from the level above, producing a cumulative resolved config. The project overlay is the leaf and is authoritative on conflict. `discardInherited` at any level resets the relevant scope to "nothing" before that level's own values are applied (per C3).

## Merge rules per splice point

Applied at both user ⊕ default and project ⊕ user-resolved steps. Unless `discardInherited` is set for the block or field, these are the default rules.

| Splice point | Shape | Merge rule |
|---|---|---|
| `stack.override` | list of stack names | **Union, dedup by string.** No element-level conflict possible. |
| `proposer.additionalCriteria` | list of `{name, description, threshold}` | **Union, keyed by `name`.** On duplicate `name` between tiers, **higher tier wins** (its `description` and `threshold` replace the lower tier's entry for that name). |
| `proposer.additionalContext` | list of file paths | **Project-only.** User overlay declaring this is a hard error per C3. |
| `planner.additionalContext` | list of file paths | **Project-only.** Same rule. |
| `generator.additionalRules` | list of strings | **Union, dedup by exact string.** No conflict model. |
| `evaluator.additionalChecks` | list of `{command, on_failure}` | **Union, keyed by `command`.** On duplicate `command` between tiers, **higher tier wins** (its `on_failure` replaces the lower tier's). |
| `runner.thresholdOverride` | integer | **Higher tier wins if defined.** Any non-empty higher-tier value replaces the lower-tier value. |

"Higher tier" means closer to the leaf: project > user > default. List merges preserve order: lower-tier entries appear first, higher-tier entries appended after, so downstream consumers that care about list order see a predictable sequence.

**Duplicate-key positioning.** When a higher-tier entry overrides a lower-tier entry by key (e.g. same `name` in `additionalCriteria`, same `command` in `additionalChecks`), the overriding entry takes the **lower-tier slot's position** — not the appended position. This avoids surprise reordering when a higher tier merely refines an existing entry. The lower-tier entry is removed; the higher-tier entry is inserted at the lower-tier's index.

**Execution-order semantics.** For lists of commands (`evaluator.additionalChecks`), merge order *is* execution order: lower-tier entries run before higher-tier entries appended after them. Consumers may rely on this ordering. A user-tier check that must run before a project-tier check is a legitimate use case; a project-tier check that depends on a user-tier check having already run is also legitimate.

## `discardInherited` interaction

For each block or field, if `discardInherited: true` is set at a given level, that level's merge input from the tier above is treated as empty before that level's own values are applied. Mechanism and syntax in C3.

Consequences:

- `discardInherited: true` in the **user overlay** at `proposer` block level means "my proposer config replaces the defaults, not merges with them." Most defaults are empty lists so this is usually a no-op, but it has teeth for `runner.thresholdOverride` where the default is a real number.
- `discardInherited: true` in the **project overlay** at `proposer` block level means "my proposer config replaces the user-resolved view, which already folded in the defaults." Effectively "default and user are both discarded for this block."
- Field-level `discardInherited` narrows the scope to a single field within the block. A field-level `discardInherited: false` inside a block that declared `discardInherited: true` preserves that one field's merge behavior — more-specific wins.

## Acceptance criteria

### Scalar merge

- With only a user overlay setting `runner.thresholdOverride: 8`, every project run uses threshold 8.
- With a user overlay setting threshold 8 and a project overlay setting threshold 9, the project runs with threshold 9.
- With a user overlay setting threshold 8 and a project overlay declaring `runner.discardInherited: true` with no `thresholdOverride` of its own, the project runs with the agent's baked-in default threshold.

### List merge

- With a user overlay adding criterion `A` and a project overlay adding criterion `B`, every contract contains both (order: user first, project second).
- With a user overlay adding criterion named `X` (threshold 8) and a project overlay adding criterion named `X` (threshold 9), contracts contain only the project entry with threshold 9.
- With a user overlay declaring `stack.override: [foo]` and a project overlay declaring `stack.override: [bar]`, the active set contains both `foo` and `bar`.
- With a user overlay declaring `stack.override: [foo]` and a project overlay declaring `stack.discardInherited: true` plus `stack.override: [bar]`, the active set is exactly `[bar]`.
- With a user overlay declaring `evaluator.additionalChecks: [{command: "X", on_failure: warning}]` and a project overlay declaring the same command with `on_failure: blockingConcern`, the project entry wins.

### Block-level and field-level discard

- A project overlay declaring `proposer.discardInherited: true` with its own `additionalCriteria` list causes the final `proposer.additionalCriteria` to be exactly the project's list.
- A project overlay declaring field-level `generator.additionalRules.discardInherited: true` plus `generator.additionalRules.value` discards user-level `additionalRules` while leaving other fields in the `generator` block merged normally.
- A project overlay declaring block-level `discardInherited: true` on a block with a nested field carrying `discardInherited: false` preserves the nested field's merge semantics.

## Dependencies

- C3 (overlay schema this cascade resolves against).

## Bite-size note

The cascade is one resolver function in R1 (`resolveCascade()`). Sprintable as: scalar merge first, then list merge with deduplication, then `discardInherited` semantics. Each step has its own acceptance criteria above so it's testable independently.

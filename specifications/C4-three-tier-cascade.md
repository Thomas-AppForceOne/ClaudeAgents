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

The per-splice-point merge rules are catalogued authoritatively in **[C3's splice-point catalog](C3-overlay-schema.md#splice-point-catalog-authoritative)**. This spec does not duplicate that table; it specifies the cascade *mechanics* (how the rules in C3 are applied across tiers) without restating each rule.

The rules in C3 apply at both user ⊕ default and project ⊕ user-resolved steps. Unless `discardInherited` is set for the block or field, the catalog's "merge rule" column gives the operative semantics.

**Common patterns:**

- **Union, dedup by string** (e.g. `generator.additionalRules`): concatenate; remove duplicate strings; preserve lower-tier-first ordering.
- **Union, keyed by `<key>`** (e.g. `proposer.additionalCriteria` keyed by `name`, `evaluator.additionalChecks` keyed by `command`): concatenate by key; on duplicate key, higher tier replaces lower; positioning rule below.
- **Higher tier wins if defined** (e.g. `runner.thresholdOverride`): scalar override; any non-empty higher-tier value replaces the lower-tier value.
- **Project-only** (e.g. `additionalContext`, `stack.override`, `stack.cacheEnvOverride`): user overlay declaring the field is a hard error.
- **Deep merge** (e.g. `stack.cacheEnvOverride`): map-of-map; project keys win on duplicate at any depth; otherwise additive.

"Higher tier" means closer to the leaf: project > user > default. List merges preserve order: lower-tier entries appear first, higher-tier entries appended after, so downstream consumers that care about list order see a predictable sequence.

**Duplicate-key positioning.** When a higher-tier entry overrides a lower-tier entry by key (e.g. same `name` in `additionalCriteria`, same `command` in `additionalChecks`), the overriding entry takes the **lower-tier slot's position** — not the appended position. This avoids surprise reordering when a higher tier merely refines an existing entry. The lower-tier entry is removed; the higher-tier entry is inserted at the lower-tier's index.

**Execution-order semantics.** For lists of commands (`evaluator.additionalChecks`), merge order *is* execution order: lower-tier entries run before higher-tier entries appended after them. Consumers may rely on this ordering. A user-tier check that must run before a project-tier check is a legitimate use case; a project-tier check that depends on a user-tier check having already run is also legitimate.

## `discardInherited` interaction

For each block or field, if `discardInherited: true` is set at a given level, that level's merge input from the tier above is treated as empty before that level's own values are applied. Mechanism and syntax in C3.

Consequences:

- `discardInherited: true` in the **user overlay** at `proposer` block level means "my proposer config replaces the defaults, not merges with them." Most defaults are empty lists so this is usually a no-op, but it has teeth for `runner.thresholdOverride` where the default is a real number.
- `discardInherited: true` in the **project overlay** at `proposer` block level means "my proposer config replaces the user-resolved view, which already folded in the defaults." Effectively "default and user are both discarded for this block."
- Field-level `discardInherited` narrows the scope to a single field within the block. A field-level `discardInherited: false` inside a block that declared `discardInherited: true` preserves that one field's merge behavior — more-specific wins.

**Discard-then-empty resolution rule.** When `discardInherited: true` is set at a level and that level provides no replacement value for the field, the field falls back to the **agent's bare default** (i.e. the value declared in C3's catalog as the "default" column). Discarding does not produce an "undefined" or "empty" state for fields whose default is well-defined. Examples:

- Project overlay sets `runner.discardInherited: true` with no `thresholdOverride`. The field falls back to the agent's baked-in threshold (per C3's catalog default), not to "unset."
- Project overlay sets `proposer.discardInherited: true` with no `additionalCriteria`. The field falls back to `[]` (empty list) per C3.

This rule is what makes `discardInherited` a precise tool: it discards the cascade *contribution* but does not damage the underlying field's default-value contract.

### Worked example: duplicate-key positioning across cascade

User overlay declares:

```yaml
evaluator:
  additionalChecks:
    - command: "./bin/check-A"
      on_failure: warning
    - command: "./bin/check-B"
      on_failure: warning
    - command: "./bin/check-C"
      on_failure: warning
```

Project overlay declares:

```yaml
evaluator:
  additionalChecks:
    - command: "./bin/check-B"        # overrides user's B
      on_failure: blockingConcern
    - command: "./bin/check-D"        # appended
      on_failure: warning
```

After merge per the rules in C3 and the duplicate-key positioning rule above, the resolved list is:

```
[A (user, warning), B (project-overridden, blockingConcern), C (user, warning), D (project, warning)]
```

Note that B's *position* stays where the user declared it (slot 2), but B's *content* is the project's. D appends after C. Execution order is A → B' → C → D — so any check that depended on B running with `warning` semantics now sees `blockingConcern`, and a check that depended on running before B is unaffected by D. **In-place override, not append.** Document this in your overlay if your additionalChecks have order-sensitive dependencies.

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

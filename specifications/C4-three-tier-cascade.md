# C4 — Three-tier overlay cascade

## Problem

Some preferences are personal and cross-project: a user always wants `--threshold 8`, always disables telemetry, always prefers a specific base branch naming convention, always wants `detekt` run as an additional evaluator check. Forcing these into every project's `.claude/gan/project.md` creates repetition and bleeds personal choices into shared config that may be committed to the repo.

## Proposed change

Add a user-scoped overlay: `~/.claude/gan/config.md`. Same parse contract and schema as the project overlay (spec C3). Precedence is defined by the cascade below.

## Cascade

Three levels, from most general to most specific:

1. **Defaults** — baked into the agent. Always present. Values listed in spec C3's splice-point table.
2. **User overlay** (`~/.claude/gan/config.md`) — personal preferences, cross-project. Optional.
3. **Project overlay** (`.claude/gan/project.md`) — per-project adjustments. Optional.

Each level is merged into the resolved view from the level above, producing a cumulative resolved config. The project overlay is the leaf and is authoritative on conflict. `discardInherited` at any level resets the relevant scope to "nothing" before that level's own values are applied (spec C3).

## Merge rules per splice point

Applied at both user ⊕ default and project ⊕ user-resolved steps. Unless `discardInherited` is set for the block or field, these are the default rules.

| Splice point | Shape | Merge rule |
|---|---|---|
| `stack.override` | list of stack names | **Union, dedup by string.** No element-level conflict possible. |
| `proposer.additionalCriteria` | list of `{name, description, threshold}` | **Union, keyed by `name`.** On duplicate `name` between tiers, **higher tier wins** (its `description` and `threshold` replace the lower tier's entry for that name). |
| `proposer.additionalContext` | list of file paths | **Project-only.** User overlay declaring this is a hard error at load time; paths are project-relative. |
| `planner.additionalContext` | list of file paths | **Project-only.** Same rule. |
| `generator.additionalRules` | list of strings | **Union, dedup by exact string.** No conflict model. |
| `evaluator.additionalChecks` | list of `{command, on_failure}` | **Union, keyed by `command`.** On duplicate `command` between tiers, **higher tier wins** (its `on_failure` replaces the lower tier's). |
| `runner.thresholdOverride` | integer | **Higher tier wins if defined.** Any non-empty higher-tier value replaces the lower-tier value. |

"Higher tier" means closer to the leaf: project > user > default. "Union, user-first" ordering produces a deterministic concat order (user entries precede project entries in the resulting list) so downstream consumers that care about list order see a predictable sequence.

## `discardInherited` interaction

For each block or field, if `discardInherited: true` is set at a given level, that level's merge input from the tier above is treated as empty before this level's own values are applied. The mechanism and syntax are defined in spec C3 (same schema for both overlays).

Consequences:

- `discardInherited: true` in the **user overlay** at `proposer` block level means "my proposer config replaces the default, not merges with it." Today most defaults are empty lists so this is usually a no-op, but it has teeth for `runner.thresholdOverride` where the default is a real number.
- `discardInherited: true` in the **project overlay** at `proposer` block level means "my proposer config replaces the user-resolved view, which already folded in the default." Effectively "default and user are both discarded for this block."
- Field-level `discardInherited` narrows the scope to a single field within the block. A field-level `discardInherited: false` inside a block that declared `discardInherited: true` preserves that one field's merge behavior (more-specific wins).

## Other rules

- Parse contract, `schemaVersion` policy, and unknown-key handling are inherited from spec C3 (same schema for both overlays).
- User overlay never reads files via `additionalContext` keys (enforced by the per-splice-point rule above). A user overlay declaring either `additionalContext` key produces a hard error at load time.
- Missing user overlay is a no-op.

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
- With a user overlay declaring `evaluator.additionalChecks: [{command: "X", on_failure: warning}]` and a project overlay declaring the same command with `on_failure: blockingConcern`, the project entry wins (check X runs as a blocking concern).

### Block-level and field-level discard

- A project overlay declaring `proposer.discardInherited: true` with its own `additionalCriteria` list causes the final `proposer.additionalCriteria` to be exactly the project's list — no user-level entries leak through.
- A project overlay declaring field-level `generator.additionalRules.discardInherited: true` plus `generator.additionalRules.value` discards user-level `additionalRules` while leaving any other fields in the `generator` block merged normally.
- A project overlay declaring block-level `discardInherited: true` on a block with a nested field carrying `discardInherited: false` preserves the nested field's merge semantics.

### Validation

- Referencing `additionalContext` in the user overlay produces a hard error at load time.
- An unknown splice point in either overlay produces a hard error naming the offending key.
- A `discardInherited` value that is neither `true` nor `false` produces a hard error.

## Dependencies

- C3.

## Value / effort

- **Value**: medium. Quality-of-life for power users; unlocks the auto-memory integration path (a user's memory system can populate this file without touching ClaudeAgents internals).
- **Effort**: small — reuses the 09 loader with a different path and the cascade pass defined above.

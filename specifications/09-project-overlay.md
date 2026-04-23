# 09 — Project overlay file

## Problem

Projects often need small, local adjustments to `/gan` behavior without forking agents or forking the stack files: add a criterion that always applies, override stack detection for a polyglot repo where dispatch picks wrong, tighten a threshold. Today the only option is shadowing the agent in `.claude/agents/`, which forks hundreds of lines of prompt to tweak one setting.

## Proposed change

Add a project-scoped overlay file: `.claude/gan/project.md`. The repo owns the path and schema; the user opts in by creating the file. Missing file = no overlay, defaults apply. This path is zone 1 (config) in the filesystem layout defined in [spec 14](14-gan-filesystem-layout.md); it is user-authored and committed to the repo.

## Parse contract

Same parse contract as stack files (spec 04): YAML frontmatter with `schemaVersion`, followed by a single canonical YAML body block. Markdown prose outside the YAML block is human-only and never read for semantic content.

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

## Splice-point reference

| Path | Shape | Default |
|---|---|---|
| `stack.override` | list of stack names | `[]` |
| `proposer.additionalCriteria` | list of `{name, description, threshold}` | `[]` |
| `proposer.additionalContext` | list of file paths (spec 10) | `[]` |
| `planner.additionalContext` | list of file paths (spec 10) | `[]` |
| `generator.additionalRules` | list of strings | `[]` |
| `evaluator.additionalChecks` | list of `{command, on_failure}` | `[]` |
| `runner.thresholdOverride` | integer | agent's baked-in threshold |

The cascade and merge semantics across default → user → project are defined in [spec 11](11-user-overlay.md).

## `discardInherited`

Either overlay may declare `discardInherited: true` to discard all upstream values for a block or a single field, resetting it to the "nothing" state before applying this overlay's own values. Intended for cases where merge would yield the wrong result — typically because a user-level default is inappropriate for a specific project.

**Block-level** — flag sits alongside the splice points inside a block and discards all fields under that block:

```yaml
proposer:
  discardInherited: true     # drop every upstream proposer.* value
  additionalCriteria:
    - name: company_only
      threshold: 10
```

**Field-level** — wrap the field's value as `{ discardInherited: true, value: <original-value> }`. Discards only that field:

```yaml
generator:
  additionalRules:
    discardInherited: true
    value:
      - "Company-only rule set, not merged with user defaults."
```

Rules:

- Allowed at both user and project overlay levels. User-level discard targets the agent-baked default; project-level discard targets the user-resolved view (which already includes the default).
- If omitted, the field/block follows normal merge semantics (spec 11).
- `discardInherited: false` is valid and equivalent to omission. Useful when a field-level `false` needs to override a block-level `true` (see precedence below).
- If both block-level `discardInherited: true` and a field inside the block carry their own `discardInherited: false`, the field-level value wins for that specific field — the rest of the block is still discarded. The more-specific declaration is authoritative.
- `discardInherited` without a replacement value is allowed and resets the field to its default (or to nil, if that level is the one being discarded).
- An unknown path passed as a field-level wrapper (i.e. a `{discardInherited, value}` shape on a field that doesn't accept a structured form) is a hard error.

## Other rules

- Agents read `project.md` **after** loading the active stacks; the overlay's role is to shape criteria and context, not to restate stack mechanics.
- ClaudeAgents is pre-1.0 and carries no backward-compatibility guarantees; `schemaVersion` is a structural marker. Overlays must declare the exact version their agents understand; a mismatch is a hard error. Any schema change — additive or breaking — bumps the version.
- Unknown splice-point keys in either overlay are a hard error at load time; agents never silently ignore a misspelled key.

### When to use `stack.override` vs. a project-tier stack file

Both this overlay and spec 12's three-tier resolution let a project change its active stack set. Pick deliberately:

- Use **`stack.override`** here when the stack file (its detection rules, audit commands, surfaces) is correct and you only need to shape which stacks are active — e.g. a KMP repo where auto-detection picks `web-node` for the JS interop module and you want to force `[kmp]`. Note that by default `stack.override` merges with the user-level list (union with dedup); combine with `stack.discardInherited: true` if you want the project list to be authoritative alone.
- Use a **project-tier stack file** (`.claude/gan/stacks/<name>.md`, spec 12) when the stack's *contents* need to change for this project — e.g. a different `auditCmd`, a tighter `scope`, project-specific `securitySurfaces`. Spec 12 replaces the tier-3 stack file with the project-tier one wholesale.
- Combining both is allowed: a project-tier stack file defines the stack, and `stack.override` in this overlay brings it into the active set.

## Acceptance criteria

- A `project.md` with `proposer.additionalCriteria` causes the listed criteria to appear in every generated contract for that project, merged with any user-level criteria per spec 11.
- A `project.md` with `evaluator.additionalChecks` runs those checks during evaluation; a failing command produces the declared `on_failure` signal.
- A `project.md` with `stack.override` contributes the named stacks to the active set.
- A `project.md` declaring `proposer.discardInherited: true` causes the final `proposer.*` values to be exactly what the project declared — no user-level `additionalCriteria` or `additionalContext` entries leak through.
- A `project.md` declaring field-level `generator.additionalRules.discardInherited: true` with its own `value` discards user-level `additionalRules` while leaving other fields in the `generator` block merged normally.
- A malformed `project.md` halts the run with a clear error — never silently ignores fields.
- An unknown splice-point key halts the run with an error naming the key.
- Missing `project.md` is a no-op; agents behave as if only defaults applied.

## Dependencies

- 04 (parse contract), 05 (stack.override only meaningful once stacks exist).

## Value / effort

- **Value**: high. This is the main user-facing customisation lever.
- **Effort**: medium. Schema discipline matters: every splice point added here becomes a contract the repo cannot break. Start with the five above and resist growth until real cases arrive.

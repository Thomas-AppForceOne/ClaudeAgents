# A2 — Generator scope enforcement

> **Status:** targeted at v1.1. Not operative until then. Authored pre-v1.1 only because the design is architectural (no usage data required). Its schema additions — `roleScopes` on `stack-v1`, `safety.scopeEnforcement` on `overlay-v1` — land **with A2 in v1.1** and are **additive**, so per the schema-versioning ruling (roadmap § "Schema-versioning ruling") they edit the `v1` files in place with **no** `schemaVersion` bump. There is therefore **no** v1.0 landing requirement: an earlier draft claimed deferring the fields to v1.1 would force a bump, but the resolved additive-stays-v`N` ruling makes that false, and no v1.0 slot owns these fields.

## Problem

H1's framework-owned confinement hook gates *where* a sprint can write — only inside `.gan-state/runs/<run-id>/worktree/`. But the worktree is a copy of the entire project root, so within the worktree any agent role with write access can touch any file. There is no per-sprint declaration of "this sprint promises to modify these files and only these files."

Three failure modes A2 closes:

- **Out-of-scope writes by the generator.** A sprint targeting `src/auth/` can quietly modify `src/billing/` if the generator reasons its way into "while I'm here, let me also fix this." The trace records the writes; nothing halts them.
- **Cross-role over-permission.** Today every agent role inherits the same scope. The evaluator never needs to write source — its only legitimate write is the evidence bundle (per T1). The clarifier never needs write access at all. Granting all roles the same write authority is the safety equivalent of giving every employee admin keys.
- **Silent unintended writes.** Generators occasionally produce edits no one declared as in-scope: regenerated lockfiles, formatter sweeps, "while I'm here" config tweaks. v1.0's trace records them but doesn't flag them. A2 turns the trace into a check.

A2 is the second spec under the **A** (agent safety) phase code, after [A1](A1-loop-and-thrash-detection.md). Where A1 detects loops in *attempt sequences*, A2 detects violations in *write targets*. Both halt with structured errors via T1's `safetyHalt` event class.

## Proposed change

### Sprint-declared `writeScope`

The contract proposer (per `agents/gan-contract-proposer.md`) adds a sprint-level `writeScope` field listing the file globs the sprint promises to touch. The orchestrator reads `writeScope` at sprint start and translates it into PreToolUse hook rules; H1's confinement hook gains a per-sprint augmentation table sourced from this field.

Contract-format addition:

```json
{
  "sprintNumber": 2,
  "features": ["add OAuth handler"],
  "writeScope": [
    "src/auth/**/*.ts",
    "tests/auth/**/*.test.ts",
    "package.json"
  ],
  "criteria": [ ... ]
}
```

A write outside `writeScope` halts the sprint with a `ScopeViolation` structured error, recorded as a `safetyHalt` event with `safetyClass = "scopeViolation"` per T1's event taxonomy. T1 already reserves `scopeViolation` as a `safetyHalt` discriminator; A2 lights it up.

### Per-role scope splits within a stack

Today `scope` globs in stack files are per-stack — every agent role inside a sprint sees the same scope. A2 introduces per-role narrowing so different roles can have different read and write sets.

Stack-file extension:

```yaml
roleScopes:
  gan-generator:
    write: ["**/*.ts", "**/*.tsx", "package.json"]
    read:  ["**/*.ts", "**/*.tsx", "**/*.md", "package.json", "tsconfig*.json"]
  gan-evaluator:
    write: []                 # evaluator never writes source
    read:  ["**/*"]           # evaluator may read everything in scope
  gan-clarifier:
    write: []                 # clarifier never writes
    read:  ["**/*.md", "**/*.txt", "**/*.json"]
```

The principle (from operator-side framing): **the writing agent does not need the reader's permissions, and the reader does not need the writer's permissions.** Default behavior is unchanged — when `roleScopes` is absent, all roles see the stack's full scope. Narrowing is opt-in per stack and audited via the trace (every `toolCall` event already carries `role`; A2 adds the resolved scope as an `inputDigest`-equivalent field).

`writeScope` (sprint-declared) is intersected with the role's `roleScopes.<role>.write` (stack-declared). The effective allow-set for a write is the intersection: the sprint promised to touch these globs AND the role is permitted to touch them. A write outside the intersection is a `ScopeViolation`.

### Halt contract

A scope violation halts identically to A1 halts — same `safetyHalt` event class, same recoverability via O2, same `--reset-scope` semantics for resuming after adjustment. The structured error:

```yaml
errorCode: ScopeViolation
role: gan-generator
attemptedPath: "src/billing/refund.ts"
reason: "outOfSprintWriteScope" | "outOfRoleWriteScope" | "outOfStackScope"
sprintWriteScope: ["src/auth/**/*.ts", ...]
roleWriteScope: ["**/*.ts", "**/*.tsx", "package.json"]
```

`reason` is a discriminator: `outOfSprintWriteScope` (sprint promised not to), `outOfRoleWriteScope` (this role isn't permitted to), `outOfStackScope` (the stack's overall scope doesn't cover this file). The three are reported separately so the user knows which boundary they need to widen — adjusting the sprint contract is different from adjusting the stack-file `roleScopes` is different from adjusting the stack's main `scope`.

### Default enforcement mode

The new overlay splice point `safety.scopeEnforcement` controls whether scope violations halt or warn:

| Value | Behavior |
|---|---|
| `"halt"` (default in v1.1) | Scope violation halts the sprint. |
| `"warn"` | Violation produces a structured warning in the trace and the startup log; the sprint continues. |
| `"off"` | No enforcement. Discouraged; equivalent to v1.0 behavior. Logged loudly. |

Defaults to `"halt"` in v1.1 because lenient defaults teach users that scope is decorative. Users who hit false positives during early v1.1 dogfooding can drop to `"warn"` per project; the v1.1 → v1.2 revision break audits whether the default needs softening.

### Glob granularity

The default glob granularity for `writeScope` and `roleScopes` is informed by v1.0 trace data: which paths are written by which roles, how often, in what combinations. A2's *defaults* (the boilerplate `roleScopes` shipped in `web-node.md` and other built-in stacks) are tuned in the v1.1 sprint that lands A2's implementation, after the v1.0 dogfooding audit. The schema and the halt path are designed now; the default values come later — pre-tuning produces overconfident defaults.

### What A2 does not do

- Per-criterion `writeScope` (a finer cut where each criterion declares its own scope). Deferred to v1.2 if v1.1 dogfooding shows sprint-level scope is too coarse.
- Semantic-level checks ("don't break existing API contracts"). That belongs to V/Q-series work in v2.0; A2 is path-based only.
- Cross-stack scope coordination. Each stack's `roleScopes` is independent; polyglot projects with multiple active stacks see the union across stacks (consistent with C2's union-by-active-stacks rule).
- Read-side enforcement. v1.1 enforces `write` only — read enforcement requires deeper Claude Code integration (read-time hooks) that the current PreToolUse surface does not support cleanly. The `read` field on `roleScopes` is recorded in the trace but not gated; it documents intent and prepares for a future v2.0+ enforcement pass.
- Replace H1's confinement hook. A2 augments H1; H1 still gates the worktree boundary, A2 gates inside the worktree.

## Schema additions

A2's implementation PR adds:

- One entry to `schemas/stack-v1.json`: `roleScopes` (optional; map of `<role>` (kebab-case) to `{write?: string[], read?: string[]}`; default absent). Per-role narrowing of the stack's `scope`. Absent = all roles see the stack's full `scope`. Both `write` and `read` are individually optional within a role declaration; an absent inner field inherits from the stack's main `scope`. Role keys match the existing agent IDs (`gan-clarifier`, `gan-planner`, `gan-contract-proposer`, `gan-generator`, `gan-contract-reviewer`, `gan-evaluator`).
- One entry to `schemas/overlay-v1.json`: `safety.scopeEnforcement` (enum `"halt" | "warn" | "off"`, default `"halt"`, both tiers, scalar cascade). Falls under the `safety.*` namespace reserved by A1.
- One sprint-level field on the contract artifact (per `agents/gan-contract-proposer.md`): `writeScope` (optional array of POSIX repo-relative glob strings; absent = no sprint-scope enforcement, only role-scope). Sprint-level promise of which paths the generator will touch. Per-criterion `referenceArtifacts` is unchanged.

The schemas are the canonical inventory.

## Field encodings

A2's structured-error fields and trace-event fields follow these encodings, common to v1.0 specs introducing new schema-bearing types:

- **Field names:** camelCase ASCII.
- **Error codes:** PascalCase ASCII (e.g. `ScopeViolation`).
- **Discriminator string values:** camelCase ASCII (e.g. `outOfSprintWriteScope`).
- **Role IDs:** kebab-case ASCII.
- **Globs:** POSIX, repo-relative, no leading separator. Match semantics per F3's picomatch determinism pin.

## Examples

A web-node stack declaring per-role scope:

```yaml
name: web-node
scope: ["**/*.ts", "**/*.tsx", "**/*.js", "package.json"]
roleScopes:
  gan-generator:
    write: ["**/*.ts", "**/*.tsx", "package.json"]
    read:  ["**/*.ts", "**/*.tsx", "**/*.md", "package.json", "tsconfig*.json", ".env.example"]
  gan-evaluator:
    write: []
    read:  ["**/*"]
  gan-clarifier:
    write: []
    read:  ["**/*.md", "README*", "package.json"]
```

A `ScopeViolation` payload:

```yaml
errorCode: ScopeViolation
role: gan-generator
attemptedPath: "src/billing/refund.ts"
reason: outOfSprintWriteScope
sprintWriteScope:
  - "src/auth/**/*.ts"
  - "tests/auth/**/*.test.ts"
  - "package.json"
roleWriteScope:
  - "**/*.ts"
  - "**/*.tsx"
  - "package.json"
```

## Acceptance criteria

### Automated checks

- A sprint with `writeScope: ["src/auth/**/*.ts"]` whose generator attempts to write `src/billing/refund.ts` halts with `ScopeViolation.reason = "outOfSprintWriteScope"`.
- A stack with `roleScopes.gan-evaluator.write: []` whose evaluator attempts to write a source file halts with `ScopeViolation.reason = "outOfRoleWriteScope"`.
- A user overlay setting `safety.scopeEnforcement: "warn"` produces a warning event in the trace and continues the sprint instead of halting.
- The `safetyHalt` event written on a scope violation has `safetyClass = "scopeViolation"` per T1's discriminator.
- A halted sprint is recoverable via `--recover` (per O2). Recovery preserves the trace; the user adjusts the sprint contract or the stack file before resuming.
- The intersection rule holds: a write that satisfies `roleScopes` but not `writeScope` halts with `outOfSprintWriteScope`; a write that satisfies `writeScope` but not `roleScopes` halts with `outOfRoleWriteScope`.

### Manual review checks

- The user-facing halt message obeys the framework's error-text discipline (no maintainer-only script names, no Node/npm leaks).
- The default `roleScopes` shipped in `web-node.md` and other built-in stacks reflect the v1.0 trace-data findings on which roles legitimately wrote which paths.
- The `read` field is recorded in the trace but does not gate behavior in v1.1 (documented as a v2.0+ enforcement candidate).

## Dependencies

- **F1** — zone semantics; A2 enforcement happens inside the worktree, not at the worktree boundary.
- **F2** — structured-error model; A2 emits `ScopeViolation` via the existing F2 channel.
- **F3** — schema authority for the `roleScopes` C1 field, the `safety.scopeEnforcement` C3 splice point, and the `writeScope` contract field.
- **C1** — new optional `roleScopes` stack-file field rides with A2.
- **C2** — A2 respects active-stack union; polyglot projects see the union of `roleScopes` across active stacks.
- **C3** — `safety.*` overlay namespace (already established by A1).
- **T1** — `scopeViolation` discriminator on `safetyHalt`; T1 reserved the slot, A2 lights it up.
- **A1** — same halt-contract pattern; same `safety.*` namespace.
- **H1** — PreToolUse confinement hook; A2 augments it with per-sprint write-scope rules.
- **O2** — recovery; A2 halts produce recoverable run state.
- **agents/gan-contract-proposer.md** — adds the `writeScope` field to the contract format.

## Bite-size note

Sprintable as:

1. (one sprint) Schema additions: C1 `roleScopes`, C3 `safety.scopeEnforcement`, contract `writeScope`. Validation and default values.
2. (one sprint) Hook integration: H1 augmentation with per-sprint write-scope rules; PreToolUse halt path.
3. (one sprint) Halt contract: `ScopeViolation` error code, three `reason` discriminators, `safetyHalt` event with `scopeViolation` discriminator.
4. (one sprint) Default `roleScopes` for `web-node.md` and `generic.md`, tuned against v1.0 trace data from the v1.0 → v1.1 audit.
5. (rides with R3) Documentation: `gan stacks list` reports per-role scopes; `gan validate` highlights overlay overrides.

Slices 1–3 must land in order; slice 4 depends on 1–3 and the audit; slice 5 lands with R3 maintenance work.

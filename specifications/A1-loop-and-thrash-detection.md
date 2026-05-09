# A1 — Loop and thrash detection

## Problem

The pipeline today has no upper bound on attempts. A planner that produces an unworkable spec, a contract proposer that keeps re-proposing the same shape, a generator that oscillates between two competing edits, or an evaluator-generator pair that disagree forever can all run indefinitely. The only halt mechanism is the user pressing Ctrl-C.

Three failure modes need separate handling:

- **Runaway role.** A single agent role attempts the same step many times without convergence (e.g. generator regenerating the same hunk after each evaluator rejection).
- **Sprint-wide thrash.** Multiple roles cycle through plan → contract → generation → evaluation → revision → … without producing a result that scores higher than the previous round.
- **Edit oscillation.** The generator's net edits across attempts revert each other (introduce X, remove X, reintroduce X), suggesting the agent is alternating between two interpretations rather than converging.

Without detection of these, v1.0 cannot ship safely: a single misbehaving prompt can burn through any token budget and produce no useful output.

A1 introduces a framework-owned safety layer with three guarantees:

1. Every multi-attempt role has a hard ceiling on attempts. Reaching it halts the sprint with a structured error.
2. Every sprint has a global ceiling on combined work. Reaching it halts the sprint with a structured error.
3. The framework detects edit-level oscillation across generator attempts and halts before the per-role ceiling is reached.

A1 is the first spec under the **A** (agent safety) phase code.

## Proposed change

### Attempt ceilings

A1 applies a per-role ceiling to agent roles that may run multiple times within a sprint. Single-attempt roles (clarifier, planner) are not subject to per-role ceilings — by definition they run once. Their attempts still appear in the trace and count toward the sprint-wide budget.

| Role | Default ceiling |
|---|---|
| `gan-contract-proposer` | 3 |
| `gan-generator` | 3 |

Reviewer and evaluator do not appear in the table because they run once per proposal and once per generator output respectively; their attempt counts are bounded by proposer and generator ceilings.

Reaching a per-role ceiling halts the sprint with the `LoopDetected` structured error (see "Halt contract" below).

### Default ceilings rationale

The defaults above are seed values chosen to halt early rather than late. Generator 3 and proposer 3 each allow two revision rounds in response to feedback (one initial attempt + two revisions); a fourth attempt typically signals genuine misalignment that should surface to the user rather than burn more tokens. The post-v1.0 dogfooding audit re-tunes these against trace data — the defaults are not data-derived and the spec acknowledges that openly.

### Sprint-wide attempt budget

Independent of per-role ceilings, the sprint has an aggregate ceiling on total agent invocations. Default sprint budget is **12** (sum of per-role ceilings plus headroom for clarifier, planner, reviewer, and evaluator). The sprint-wide budget guards against pathological combinations that stay under each per-role ceiling individually but cycle endlessly through different roles.

Reaching the sprint-wide budget halts with `LoopDetected` carrying `reason: "sprintBudgetExceeded"`.

Single-attempt agents (clarifier, planner) count toward the sprint budget but never trigger per-role ceilings.

### Edit oscillation detection

For the generator role specifically, A1 maintains an edit-fingerprint history across attempts within a single sprint. The fingerprint identifies the structural shape of the changes the generator proposes (paths touched + content hash per path).

A1 does not specify the fingerprint algorithm; it specifies the *normalization contract* the algorithm must satisfy. Three rules:

1. **Whitespace-only differences** between two edit sets MUST produce identical fingerprints.
2. **Comment-only differences** (per active stack's declared `commentSyntax`) MUST produce identical fingerprints.
3. **Reordering within stack-declared sortable lists** (e.g. import blocks per a stack's `sortableLists` field) MUST produce identical fingerprints.

The normalization contract requires two new C1 stack-file fields, `commentSyntax` and `sortableLists`, added in A1's implementation PR alongside the fingerprint logic. Both are optional per stack; absent fields mean the corresponding rule is a no-op for that stack.

Two distinct triggers fire `editOscillation` halts, both halting independently:

- **Direct repeat.** Any attempt's fingerprint matches an earlier attempt's fingerprint within the same role's history.
- **3-cycle.** Attempt N's fingerprint equals attempt N−2's fingerprint (an A → B → A pattern).

False-positive avoidance: the trigger only counts repeats that occurred *after* an evaluator rejection. A second attempt that legitimately reverts a partial edit because the evaluator said "undo that" is not oscillation — it's instructed behavior, and the trace records the rejection that motivated the revert.

### Halt contract

When any of the three triggers fires, the orchestrator:

1. Writes a `safetyHalt` event to the run trace (T1).
2. Emits a structured error of code `LoopDetected` with fields:
   - `reason`: discriminator — `"roleCeilingExceeded"` | `"sprintBudgetExceeded"` | `"editOscillation"`.
   - `role`: which role triggered the halt (or `"sprint"` for the sprint-wide budget).
   - `attempts`: how many attempts were made.
   - `ceiling`: the configured ceiling that was hit.
   - `evidence`: discriminator-specific shape per below.
3. Archives the run state per O2 conventions so `--recover` can resume after the user adjusts the prompt or overrides the ceiling.
4. Exits with a non-zero status code distinct from validation errors so callers can tell halts apart from contract failures.

`evidence` shapes are:

- For `roleCeilingExceeded`: an array of `{ attemptNumber, outputArtifactPath, summary }` — one entry per attempt.
- For `sprintBudgetExceeded`: `{ totalAttempts, perRoleCounts: { <role>: <int> } }`.
- For `editOscillation`: `{ fingerprintSequence: [hash, ...], detectedPattern: "directRepeat" | "3cycle" }`.

The error message rendered to the user is plain prose:

> The generator made 3 attempts at this sprint and the changes oscillated between two interpretations. The sprint has been halted to avoid wasting tokens. Trace files at `.gan-state/runs/<run-id>/trace/`. Run `--recover` after adjusting the prompt.

The message points at the trace directory directly because v1.0 ships without a `gan run trace` command — that surface is T2's scope in v1.1. When T2 lands, A1's PR for v1.1 updates the message to reference the command instead of the directory.

### Halt timing

Ceilings are checked at attempt-start boundaries. An attempt already in flight runs to completion; the next ceiling check fires after it finishes. This means an attempt-in-flight when the ceiling is reached counts toward the trace but does not abort. The trade is predictable semantics for a small worst-case extra attempt; v1.0 accepts this. Mid-attempt cancellation is deferable to a future spec if real usage shows the wasted token cost matters.

### User overrides

Users can override the default ceilings via the project overlay (per C3 splice points) or the user overlay. New splice points introduced by A1:

- `safety.attemptCeilings.<role>` — integer; per-role ceiling.
- `safety.sprintBudget` — integer; sprint-wide budget.
- `safety.oscillationDetection` — boolean; default `true`. When `false`, only ceilings apply.

Two runtime flags exist for one-off overrides without editing the overlay:

- `--max-attempts=<n>` — applies a uniform ceiling of `n` to every multi-attempt role and sets `sprintBudget = n × roleCount + 4` (the +4 covers clarifier, planner, reviewer, evaluator). Coarse but useful for debugging.
- `--reset-attempts` — valid only as a modifier to `--recover`; standalone use is an error. When set, recovery resumes with attempt counters at zero. Without the flag, recovery preserves counter state from the trace.

The runtime knob inventory in [runtime-knobs.md](runtime-knobs.md) gains `--max-attempts` and `--reset-attempts` in the same PR that lands A1.

### Recovery interaction

A sprint halted by A1 is recoverable via O2's `--recover` flow. Recovery does **not** automatically reset the attempt counters — the user must either:

- Adjust the prompt or overlay so the next attempt converges differently, then `--recover`, or
- Pass `--reset-attempts` to start the recovered sprint with fresh counters.

Without `--reset-attempts`, a recovered sprint that hits the same loop will halt again on the very next attempt. This is by design: silent counter resets defeat the purpose of the ceiling.

### Trace integration

Every attempt writes an `agentAttempt` event to the run trace (T1) carrying `role`, `attemptNumber`, and a reference to the artifacts produced. The orchestrator-side counter that drives ceilings reads from the trace; the trace is the source of truth for "how many attempts have happened." This means `--recover` can reconstruct counter state from the trace alone, without a separate counter file.

A1 emits `safetyHalt` events with discriminator `loopDetected` when a halt fires. The `safetyHalt` event class is owned by T1's schema; A1's implementation PR adds the `loopDetected` discriminator and its `evidence` payload shapes.

### What A1 does not do

- Detect *semantic* loops where outputs are different but functionally equivalent (deferred to V3 in v2.0).
- Impose token or wall-clock budgets (deferred to T3 in v1.2).
- Modify any agent's behavior — clarifier, planner, generator, evaluator are oblivious to A1; the check happens in the orchestrator at attempt boundaries (out of scope per the "framework-owned safety layer" principle).
- Provide mid-attempt cancellation (deferred — predictable boundaries chosen over fine-grained control for v1.0).
- Cross-language stack support for fingerprint normalization beyond what `commentSyntax` and `sortableLists` declare (deferred per stack; absent fields are no-ops).

## C1 amendments

A1's fingerprint normalization contract requires two new optional C1 stack-file fields. Both ride with A1's implementation PR and amend C1 in place per the existing extract-and-replace discipline.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `commentSyntax` | object — `{ line: string?, block: { open: string, close: string }? }` | absent | Declares the stack's comment syntax so fingerprint normalization rule 2 (comment-only differences) can ignore comment-only edits. Absent = rule 2 is a no-op for the stack. |
| `sortableLists` | array of objects — `[{ pathGlob: string, lineRangePattern: string }, ...]` | empty array | Declares regions of source files where line ordering is normalized away (e.g. import blocks). Absent / empty = rule 3 is a no-op for the stack. |

Both fields are optional. A stack that declares neither participates in fingerprint detection only via rule 1 (whitespace-only differences), which is language-agnostic.

## C3 amendments

A1 introduces three new overlay splice points. C3's splice-point catalog gains entries for each in A1's implementation PR.

| Splice point | Type | Default | Tier scope |
|---|---|---|---|
| `safety.attemptCeilings.<role>` | integer (positive) | per-role default from the table above | both tiers |
| `safety.sprintBudget` | integer (positive) | 12 | both tiers |
| `safety.oscillationDetection` | boolean | `true` | both tiers |

All three follow C4's scalar cascade rule (higher-tier wins). `discardInherited` semantics apply per C3's standard rules.

## Field encodings

A1's structured-error fields and trace-event fields follow these encodings, common to v1.0 specs introducing new schema-bearing types and aligned with conventions established by F2 / F4 / U3:

- **Field names:** camelCase ASCII (e.g. `attemptNumber`, `outputArtifactPath`, `fingerprintSequence`).
- **Error codes:** PascalCase ASCII as Type-like names (e.g. `LoopDetected`, matching F4's `UntrustedOverlay` and U3's `PathEscape`).
- **Enum / discriminator string values:** camelCase ASCII (e.g. `editOscillation`, `roleCeilingExceeded`, `directRepeat`).
- **Role IDs:** kebab-case ASCII (e.g. `gan-generator`, matching the existing agent-file naming convention).
- **terminalReason codes** (when A1 writes to `progress.json`): kebab-case ASCII (e.g. `failed-loop-detected`, matching O2's existing convention).
- **Hashes:** SHA-256, hex-encoded lowercase, 64 chars.
- **Timestamps:** RFC 3339 UTC with millisecond precision.
- **Sequence numbers:** monotonic non-negative integers, no gaps.
- **Paths:** relative POSIX from a defined root, no leading separator.

The PascalCase / camelCase distinction between error codes (`LoopDetected`) and trace-event discriminators (`loopDetected`) is intentional: F2's structured-error layer treats codes as types, T1's trace layer treats discriminators as enum values. Both naming styles refer to the same concept across different namespaces.

This convention is duplicated across A1, T1, and E5 for v1.0; an F3 update in v1.1 centralises it.

## Examples

A `LoopDetected` error payload for the `editOscillation` discriminator:

```yaml
errorCode: LoopDetected
reason: editOscillation
role: gan-generator
attempts: 3
ceiling: 3
evidence:
  detectedPattern: "3cycle"
  fingerprintSequence:
    - "a3f2c8b1d9e7f4a6c2b8d1e5f9a3c7b4e2d8f1a5c9b3e7d2f8a4c1b6e9d3f7a2"
    - "b8e1c4d7f2a9e3c6b1d4f7a2e9c5b8d1f4a7c2e6b9d3f1a8c5e2b6d9f3a7c1e4"
    - "a3f2c8b1d9e7f4a6c2b8d1e5f9a3c7b4e2d8f1a5c9b3e7d2f8a4c1b6e9d3f7a2"
```

A `LoopDetected` payload for the `sprintBudgetExceeded` discriminator:

```yaml
errorCode: LoopDetected
reason: sprintBudgetExceeded
role: sprint
attempts: 12
ceiling: 12
evidence:
  totalAttempts: 12
  perRoleCounts:
    gan-clarifier: 1
    gan-planner: 1
    gan-contract-proposer: 3
    gan-generator: 3
    gan-contract-reviewer: 2
    gan-evaluator: 2
```

## Acceptance criteria

### Automated checks

- A sprint where the generator produces the same edit set across three attempts halts with `LoopDetected.reason = "editOscillation"` after the second repeat.
- A sprint where the contract proposer is rejected three times in a row halts with `LoopDetected.reason = "roleCeilingExceeded"` and `role = "gan-contract-proposer"`.
- A sprint where each role stays under its per-role ceiling but the combined attempt count exceeds the sprint-wide budget halts with `LoopDetected.reason = "sprintBudgetExceeded"`.
- A user overlay setting `safety.attemptCeilings.gan-generator: 5` raises the generator's ceiling to 5 attempts.
- A user passing `--max-attempts=2` halts every multi-attempt role at 2 attempts regardless of overlay configuration.
- Disabling `safety.oscillationDetection` allows the generator to repeat fingerprints up to its per-role ceiling without halting.
- A halted sprint is fully recoverable via `--recover`; resuming without `--reset-attempts` and without prompt changes halts on the next attempt.
- `--reset-attempts` used standalone (without `--recover`) is rejected with a structured error.
- The trace contains one `agentAttempt` event per agent invocation and one `safetyHalt` event when a halt fires.
- The `LoopDetected` payload's `evidence` field validates against the discriminator-specific shape declared in the schema.
- Whitespace-only differences across two generator attempts produce identical fingerprints (fingerprint-normalization rule 1).
- Comment-only differences (per active stack's `commentSyntax`) produce identical fingerprints (rule 2).
- Reordering within stack-declared `sortableLists` produces identical fingerprints (rule 3).

### Manual review checks

- The user-facing halt message follows the user-facing-discipline rule (no maintainer-only script names, no Node/npm leaks).
- The default ceilings table is annotated as seed values, with the rationale visible to a reader who has not read the spec set.
- The fingerprint normalization rules are stack-agnostic in spec text; stack-specific behavior is delegated to the new C1 fields rather than hardcoded for any ecosystem.

## Dependencies

- F2 (structured-error model A1 emits)
- F3 (schema authority for the `LoopDetected` error code)
- E1 (orchestrator that runs the attempt loop)
- C1 (new `commentSyntax` and `sortableLists` stack-file fields ride with A1's implementation PR)
- C3 (overlay splice points where ceilings are configured)
- O2 (recovery; A1's halt produces a recoverable state)
- T1 (`agentAttempt` and `safetyHalt` events; T1's schema must define `safetyHalt` with extension points before A1's implementation PR adds the `loopDetected` discriminator)

The T1 dependency is timing-sensitive: T1's schema PR must land first so A1 can reference the `safetyHalt` class. Both specs land within v1.0; the order of implementation PRs is T1 → A1.

## Bite-size note

Sprintable as:

1. (one sprint) Per-role ceilings + halt error contract + `evidence` shapes.
2. (one sprint) Sprint-wide budget + integration with single-attempt-agent counting.
3. (one sprint) Edit-fingerprint normalization contract + C1 additions (`commentSyntax`, `sortableLists`).
4. (one sprint) Edit oscillation detection (direct-repeat and 3-cycle triggers, post-rejection guard).
5. (rides with R3 maintenance work) Overlay splice points + `--max-attempts` + `--reset-attempts` + runtime-knobs.md update.
6. (one sprint) Recovery integration including `--reset-attempts` validation.

Slices 1–3 must land in order; slice 4 depends on slice 3; slices 5–6 can land in either order after slice 1.

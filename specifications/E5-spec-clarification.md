# E5 — Spec clarification phase

## Problem

Today's pipeline goes user prompt → planner → contract proposer → generator → evaluator. The user's prompt is treated as ground truth. When the prompt is ambiguous — and most prompts are, in ways the user does not realise — the planner makes guesses. The proposer encodes those guesses into the contract. The generator produces code against the guessed contract. The evaluator scores against the guessed contract. The user gets a result that satisfies the wrong target and cannot tell where the misinterpretation began.

There is no place in the current architecture where ambiguity in the input is *named* before it propagates downstream. Every later phase suffers as a result:

- **Planner output** mixes interpretation with planning. The user can't separate "what we decided" from "what we planned to do given that decision."
- **Contract scoring** measures conformance to the planner's interpretation, not to the user's intent.
- **Evaluator verdicts** are honest about the contract but silent about whether the contract was the right one.
- **Dogfooding signal** for v1.0 is dominated by "the planner misread me" complaints, masking everything else the team is trying to learn from real usage.

E5 introduces a clarification phase between user prompt ingestion and the planner. A new agent role, `gan-clarifier`, is responsible for *finding the ambiguity* before any downstream phase commits to a reading of it.

E5 extends the **E** (agent integration) phase code with a new role; it is not a new phase code.

## Proposed change

### Pipeline position

The clarifier runs after the orchestrator captures the user's prompt and the snapshot, and before the planner runs. The new shape:

```
user prompt + snapshot + additionalContext (U3)
        ↓
gan-clarifier      ← E5
        ↓ clarified-spec.md
gan-planner
        ↓ plan
gan-contract-proposer
        ↓ contract
... unchanged
```

The clarifier's output, `clarified-spec.md`, becomes the canonical input to the planner and the proposer. The original raw prompt is preserved alongside it (`raw-prompt.md` in the same directory), so the audit trail from raw input through clarified spec through plan is fully recoverable.

### Inputs the clarifier reads

The clarifier consumes:

1. The user prompt (raw text).
2. The U3 `additionalContext` from the **project overlay** — specifically, the union of every per-agent `additionalContext` splice (`planner.additionalContext`, `proposer.additionalContext`, and any other `<agent>.additionalContext` C3 declares). The clarifier reads the union *first* and asks only about what is still ambiguous after it. `additionalContext` is project-tier-only per U3; the user overlay cannot declare it.

   The "union" rule reflects the design principle that the clarifier sees what every downstream agent will see — there is no clarifier-specific additionalContext splice point.
3. The snapshot's active-stack identifiers and their declared file globs.
4. A **bounded directory listing**: top-level directories of the project + file lists within directories matched by active-stack scope. Not file contents; structure only. The listing is bounded by stack scope, so the clarifier cannot ground questions in repo content the active stack does not own.

The clarifier does not read arbitrary file contents (per the roadmap's out-of-scope rule). All context flows through documented surfaces.

### Finding classification

The clarifier produces three kinds of finding from the input:

- **Self-resolved.** Gaps the clarifier filled with framework-default behavior, no user interaction. (Example: user said "add tests" without specifying which test runner; clarifier resolves to whatever the active stack's `testCmd` declares.) Recorded in the trace and listed in the clarified spec but never blocking.
- **Assumption.** Gaps the clarifier filled with a sane default that the user can override before proceeding. Presented as: "I'll proceed with X unless you tell me otherwise." Marked with `assumed:` in the clarified spec.
- **Blocker.** Gaps the clarifier cannot reasonably default. Surfaced as a question to the user; sprint behavior on unanswered blockers is defined below.

This three-way split is load-bearing. Single-class clarification ("ask about everything") becomes interrogation; "default everything silently" becomes the current opaque problem. The split forces the clarifier to *justify* every question it asks.

### Gap-class catalog

The clarifier identifies gaps in five canonical classes. The catalog is the seed vocabulary that v1.1's Q2 failure-mode taxonomy expands.

1. **Constraint conflicts.** The prompt or context implies contradictory work.
2. **Scope ambiguities.** Whether a sub-feature is in or out of the sprint changes the work substantially.
3. **Target-of-N.** The prompt names a feature with multiple plausible targets (multiple files, multiple components).
4. **Success-criterion ambiguities.** What "done" means is unclear.
5. **Undefined non-goals.** What the user explicitly does NOT want is unstated and the answer affects what to avoid.

A clarifier round may detect gaps in all five classes; ranking and the question cap (below) determine which become questions.

### Question ranking

Detected gaps are ranked across all classes by a fixed two-step priority:

**Across-class priority** (higher first):
1. Constraint conflicts
2. Scope ambiguities at sprint level
3. Target-of-N
4. Success-criterion ambiguities
5. Undefined non-goals

**Within-class priority:** by *blast radius* — the number of downstream decisions that depend on the answer. A gap whose answer affects three planner decisions ranks higher than one affecting one.

The first three blockers in this combined ordering become questions; the rest downgrade to assumptions. The ranking is documented in spec, so behavior is reproducible across runs of the same prompt.

### Round budget for v1.0

v1.0 ships a deliberately minimal first cut:

- **One round.** The clarifier runs once. It does not iterate. If new ambiguities surface mid-sprint, they are evaluator concerns or revision-break concerns, not clarifier concerns.
- **At most three blockers.** Three is chosen because four-or-more questions starts to feel like a form rather than a conversation, and three fits a single screen on most terminals. v1.1's multi-round flow may add rounds but each round still caps at three to preserve the single-screen invariant.
- **No confidence scoring.** A simple heuristic (rank by impact; cap at three) is enough for first-release dogfooding.
- **No auto-promotion.** Resolved clarifications are not offered as project-tier `additionalContext` for future runs.

These constraints are documented in E5 explicitly so v1.1's expansion has a clear baseline.

### No-ambiguity case

When the clarifier finds zero blockers and no assumptions worth recording, it produces a `clarified-spec.md` with Goal populated from the user's prompt and other sections empty. The orchestrator does not present any prompt; the sprint proceeds directly to the planner. The clarifier's `agentAttempt` event still records that it ran — its existence is part of the audit trail even when its output is minimal.

### User interaction surface

When the clarifier identifies blockers, the orchestrator presents them as a single batched prompt:

```
I have three things I need clarified before I can plan this sprint:

1. You asked for "tests for the login flow" — does that include the
   password-reset path, or just sign-in?

2. Should the new tests use the existing fixtures under tests/__fixtures__/
   or generate fresh ones?

3. The login flow has both a session-cookie and a JWT path. Which one
   are you targeting? (If both, say "both.")

You can answer in plain text. Type "use defaults" to accept my proposed
assumptions for all three. Type "cancel" to abort.

You can also re-run with --skip-clarification to bypass this step entirely.
```

The user response is parsed by these rules, in order:

1. **Literal "cancel"** (case-insensitive, exact match, no surrounding words) → aborts with `UserCancelled`.
2. **Literal "use defaults"** (case-insensitive, exact match, no surrounding words) → downgrades all blockers to their proposed assumptions.
3. **Empty response** → halts with `ClarifierBlockersUnanswered` (treated as no engagement; recoverable).
4. **Free text** → parsed per-question by the clarifier.

### Partial answers

A free-text response may answer some blockers and not others. Rule: any user response that the parser engages with (rules 2 or 4 above) causes unanswered blockers to *fall through* to their proposed assumption. The clarified spec records each unanswered blocker explicitly:

> "User did not answer this blocker; proceeding with assumption: X."

The user can spot the unanswered item in the clarified spec and `--recover` if they want to redo. This is friendlier than the alternative — halt-on-any-unanswered would punish the most common failure mode (user misses one of three questions).

The run halts only when the user response is "cancel" or empty. Free text the parser cannot map to specific blockers is treated as engagement; all blockers downgrade to assumptions and the parse-failure note appears in the clarified spec.

### Output: `clarified-spec.md`

A markdown document at `.gan-state/runs/<run-id>/clarified-spec.md`. Sections:

- **Goal** — one-paragraph restatement of what the user asked for, after applying the user's blocker answers and stated assumptions.
- **In scope** — bulleted list of work items the sprint will cover.
- **Out of scope** — bulleted list of items the user did not include, with brief justification when the clarifier resolved an ambiguity in a particular direction.
- **Assumptions** — every assumption the clarifier made, marked clearly so the user can spot one to override.
- **User answers** — verbatim record of any blocker questions and the user's answers (or "User did not answer; assumption applied: X" entries).
- **Constraints** — any constraints derived from `additionalContext` or stack metadata that the user should know are shaping the sprint.

The planner consumes this document as its primary input. The proposer reads it to derive contract criteria. **The evaluator does not read the clarified spec directly** — its primary input remains the contract, which the proposer derives from the clarified spec. The clarified spec → contract → evaluator chain preserves the property that "the evaluator scores against an explicit contract, not against an interpretation of intent."

### `--skip-clarification` flag

A new `/gan` skill flag that bypasses the clarifier entirely. The orchestrator (not the clarifier — the clarifier is bypassed) writes a minimal `clarified-spec.md` with:

- **Goal:** verbatim user prompt.
- **In scope, Out of scope, User answers:** empty.
- **Assumptions:** single entry — "User invoked `--skip-clarification`; downstream agents proceed with the raw prompt as goal."
- **Constraints:** derived from `additionalContext` and active stacks (orchestrator runs this small piece of logic regardless of clarifier invocation).

Use cases:

- The user has already authored a precise prompt and wants no friction.
- The user is iterating on a known sprint and re-running with adjusted parameters.
- CI / scripted invocations where interactive prompting is impossible.

The flag is documented in [runtime-knobs.md](runtime-knobs.md) under `/gan` skill flags. It does not short-circuit `validateAll()`; clarification happens after validation in the pipeline.

The runtime-knob inventory adds `--skip-clarification` in the same PR that lands E5.

### Trust posture

The clarifier reads the prompt, `additionalContext`, and the bounded directory listing; it writes `clarified-spec.md` and `raw-prompt.md` under run state; it asks the user questions through the orchestrator UI. It does not read arbitrary repo file contents, does not run commands, does not modify the working tree. Trust posture is identical to the planner's — no new attack surface, no new F4 considerations.

The bounded directory listing is metadata, not content; listings are filtered by active-stack scope so the clarifier cannot enumerate paths outside what the stacks declare they own.

### Trace integration

The clarifier emits trace events per T1:

- One `agentAttempt` event for the clarifier role.
- One `llmCall` event for each LLM call the clarifier makes.
- One `clarifierFinding` event per gap detected, carrying:
  - `class`: `selfResolved` | `assumption` | `blocker`.
  - `gapClass`: one of the five from the gap-class catalog.
  - `payload`:
    - For `selfResolved`: `{ resolution, source }` — what the resolution was and where the default came from (e.g. stack `testCmd`).
    - For `assumption`: `{ assumed, rationale }`.
    - For `blocker`: `{ question, userAnswer }` where `userAnswer` is the user's text, the sentinel `"useDefaults"`, the sentinel `"unanswered"`, or `"cancelled"`.

`clarifierFinding` is a new event class added to T1's schema as part of E5's implementation PR. T1's schema PR must land first (per T1's stated landing order); E5's PR extends the schema with the new class.

A safety-class event of class `clarifierBlockersUnanswered` is emitted as a `safetyHalt` (per T1's safety-event extension point) when the user provides empty response.

### Sprint-budget interaction with A1

The clarifier is a single-attempt agent; A1's per-role ceilings do not apply to it. The clarifier's one attempt counts toward A1's sprint-wide budget (default 12 for v1.0). Practically, this leaves headroom for the multi-attempt agents (proposer 3, generator 3) plus the other single-attempt agents (planner, reviewer per proposal, evaluator per generator output).

### What E5 does not do

- Iterate (deferred to E5 round 2 in v1.1; one round only in v1.0).
- Score itself (deferred to v1.1 confidence scoring).
- Persist clarifications across runs (deferred to v1.1 user-confirmed promotion).
- Modify `additionalContext` (out of scope per the user-confirmed-only persistence rule).
- Validate (out of scope per orchestrator flow; `validateAll()` runs before E5).
- Read arbitrary file contents (out of scope per the additionalContext-only context rule).
- Re-prompt the user mid-round on parse failure (deferred; v1.0 falls through to assumptions).

## Field encodings

E5's clarified-spec sections and trace-event payloads follow these encodings, common to v1.0 specs introducing new schema-bearing types and aligned with conventions established by F2 / F4 / U3:

- **Field names:** camelCase ASCII (e.g. `gapClass`, `userAnswer`, `attemptNumber`).
- **Error codes:** PascalCase ASCII as Type-like names (e.g. `ClarifierBlockersUnanswered`, `UserCancelled`, matching F4's `UntrustedOverlay`).
- **Event-class names and discriminator string values:** camelCase ASCII (e.g. `clarifierFinding`, `selfResolved`, `assumption`, `blocker`).
- **Gap-class identifiers:** snake_case ASCII (e.g. `scope_ambiguity`, `target_of_n`, `constraint_conflict`) — these are catalog labels, not protocol values, and snake_case keeps multi-word labels legible.
- **Sentinel values** for `userAnswer` (`useDefaults`, `unanswered`, `cancelled`): camelCase ASCII.
- **Role IDs:** kebab-case ASCII (e.g. `gan-clarifier`).
- **terminalReason codes** (when E5 writes to `progress.json`): kebab-case ASCII (e.g. `aborted-clarifier-blockers-unanswered`, matching O2's convention).
- **Hashes:** SHA-256, hex-encoded lowercase, 64 chars.
- **Timestamps:** RFC 3339 UTC with millisecond precision.
- **Sequence numbers:** monotonic non-negative integers, no gaps.
- **Paths:** relative POSIX from a defined root, no leading separator.

The PascalCase / camelCase distinction between error codes (`ClarifierBlockersUnanswered`) and trace-event discriminators (`clarifierFinding`) is intentional: F2's structured-error layer treats codes as types, T1's trace layer treats discriminators as enum values. Both naming styles refer to the same concept across different namespaces.

This convention is duplicated across A1, T1, and E5 for v1.0; an F3 update in v1.1 centralises it.

## Examples

A `clarified-spec.md` with all sections populated:

```markdown
---
schemaVersion: 1
---

# Clarified spec

## Goal

Add automated tests covering the sign-in path of the login flow, exercising the
session-cookie authentication path and using existing fixtures under
tests/__fixtures__/. Password-reset is out of scope.

## In scope

- Unit tests for the sign-in handler at src/auth/sign-in.ts.
- Integration test that runs the sign-in flow end to end against the
  test-mode session-cookie issuer.

## Out of scope

- Password-reset flow (clarified per blocker 1).
- JWT authentication path (clarified per blocker 3).

## Assumptions

- assumed: tests use vitest (default for the active web-node stack's testCmd).
- assumed: new tests live alongside existing tests under tests/auth/.

## User answers

- Q1: "Does this include the password-reset path, or just sign-in?"
  A: just sign-in.
- Q2: "Use existing fixtures or generate fresh ones?"
  A: use existing fixtures.
- Q3: "Session-cookie or JWT path?"
  A: session-cookie.

## Constraints

- Active stack: web-node (declared in .claude/gan/project.md).
- additionalContext from project.md: "test infrastructure: vitest with
  jsdom; fixtures live at tests/__fixtures__/"
```

A `clarified-spec.md` produced by `--skip-clarification`:

```markdown
---
schemaVersion: 1
---

# Clarified spec

## Goal

Add tests for the login flow.

## In scope

(empty)

## Out of scope

(empty)

## Assumptions

- assumed: User invoked --skip-clarification; downstream agents proceed
  with the raw prompt as goal.

## User answers

(empty)

## Constraints

- Active stack: web-node (declared in .claude/gan/project.md).
- additionalContext from project.md: "test infrastructure: vitest with
  jsdom; fixtures live at tests/__fixtures__/"
```

A `clarifierFinding` trace event for a blocker:

```json
{
  "envelope": {
    "sequenceNumber": 4,
    "eventType": "clarifierFinding",
    "timestamp": "2026-05-09T09:14:22.456Z",
    "runId": "20260509-091401-c8e2"
  },
  "class": "blocker",
  "gapClass": "scope_ambiguity",
  "payload": {
    "question": "You asked for 'tests for the login flow' — does that include the password-reset path, or just sign-in?",
    "userAnswer": "just sign-in"
  }
}
```

## Acceptance criteria

### Automated checks

- An ambiguous prompt produces a `clarified-spec.md` containing Goal, In-scope, Out-of-scope, Assumptions, User-answers (when blockers existed), and Constraints sections.
- The clarifier asks at most three blocker questions per round; additional ambiguities below the cap are downgraded to assumptions and recorded as such.
- A user passing `--skip-clarification` runs straight to the planner with the minimal clarified spec defined above; `raw-prompt.md` is preserved alongside.
- A blocker question is presented as a single batched prompt, not one-at-a-time interaction.
- A user response of "use defaults" (case-insensitive, exact match) downgrades every blocker to its proposed assumption and the sprint proceeds; the clarified spec records this explicitly.
- A user response of "cancel" (case-insensitive, exact match) aborts with `UserCancelled`.
- An empty user response halts with `ClarifierBlockersUnanswered`; the run is recoverable via O2's `--recover`.
- A partial response (free text answering some blockers) causes unanswered blockers to fall through to their proposed assumption; the clarified spec records each unanswered blocker explicitly.
- The clarifier reads `additionalContext` from U3 and does not ask about anything the context already specifies (verifiable via a fixture: same prompt with vs. without context produces fewer blockers in the with-context case).
- The trace contains one `agentAttempt` event, one or more `llmCall` events, one `clarifierFinding` event per detected gap, and a `safetyHalt` event of class `clarifierBlockersUnanswered` when the user provides empty response.
- The planner reads `clarified-spec.md` as its primary input; the proposer reads it for criteria derivation; the evaluator reads only the contract.
- A perfectly-specified prompt produces a `clarified-spec.md` with empty In-scope/Out-of-scope/Assumptions/User-answers sections, and the orchestrator does not present any user prompt.
- The bounded directory listing the clarifier receives is filtered by active-stack scope; paths outside any active stack's globs are absent.
- Question ranking follows the documented across-class priority order; two runs of the same prompt with the same context produce the same ranked question set.

### Manual review checks

- User-facing question text follows the user-facing-discipline rule (no maintainer-only script names, plain prose, no Node/npm leaks).
- The five gap-class catalog entries are stable and discoverable by a v1.1 author authoring Q2.
- The "use defaults" / "cancel" parsing is exact-match-only; the spec does not silently accept paraphrases.

## Dependencies

- E1 (orchestrator flow, agent role conventions)
- U3 (`additionalContext` the clarifier consumes first)
- F1 (run-state location for `clarified-spec.md` and `raw-prompt.md`)
- F2 (structured-error model for the failure modes)
- O2 (recovery after a clarification halt)
- T1 (trace events the clarifier emits; T1's schema must be landed first so E5's implementation PR can extend it with `clarifierFinding`)
- A1 (clarifier counts toward sprint-wide budget; per-role ceilings do not apply since the clarifier is single-attempt)

## Bite-size note

Sprintable as:

1. (one sprint) Agent role authoring (`gan-clarifier.md`) covering inputs, finding classification, gap-class catalog, question ranking, and round budget.
2. (one sprint) Orchestrator integration: insert clarifier before planner; route `clarified-spec.md` to planner and proposer; bypass path for `--skip-clarification`.
3. (one sprint) `clarified-spec.md` artifact contract and downstream-consumer updates (planner, proposer wired to read it; evaluator confirmed unchanged).
4. (one sprint) User interaction surface: blocker presentation, "use defaults" / "cancel" parsing, partial-answer fall-through, empty-response halt.
5. (rides with R3 maintenance work) `--skip-clarification` flag plumbing + runtime-knobs.md update.
6. (one sprint, depends on T1 schema landing first) `clarifierFinding` trace event class + emission.
7. (one sprint) Bounded directory listing surface: snapshot extension for stack-scoped file lists.

Slices 1–4 must land in order; slice 5 can land in parallel with slice 4; slice 6 depends on T1's schema PR; slice 7 can land in parallel with slice 1 once the snapshot extension is designed.

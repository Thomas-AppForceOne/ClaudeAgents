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

### Bare invocation handling

Before the clarifier runs, the orchestrator validates that a prompt exists. A `/gan` invocation with no prompt and no flag that short-circuits agent spawning (i.e. not `--help`, `--print-config`, `--list-recoverable`, `--recover`) halts immediately with a structured error `NoPromptProvided`. The user-facing message:

> No prompt provided. Run `/gan "<your prompt here>"` to start a sprint, or `/gan --help` to see the available options.

The check fires after `validateAll()` and after the welcome banner (when applicable), but before the clarifier — there is no point invoking the clarifier with an empty prompt. The check fires before the run-lockfile is acquired (per O2's lock contract); a bare invocation never creates run state.

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

v1.0 ships an interactive draft-and-evolve flow with a hard ceiling:

- **Up to three rounds.** Initial round + up to two evolution rounds, capped at three total. Evolution rounds happen when the user types `evolve: <added context>` in response to a draft (see "Draft preview and evolution" below). Hitting the third round forces the user to choose approve / edit / cancel; further evolutions are rejected.
- **At most three blockers per round.** Three is chosen because four-or-more questions starts to feel like a form rather than a conversation, and three fits a single screen on most terminals. The cap holds across rounds.
- **No confidence scoring.** A simple heuristic (rank by impact; cap at three) is enough for first-release dogfooding. v1.1 adds confidence scoring to drive round-depth decisions automatically.
- **No auto-promotion.** Resolved clarifications are not offered as project-tier `additionalContext` for future runs (deferred to v1.1).

These constraints are documented in E5 explicitly so v1.1's expansion has a clear baseline.

### Draft preview and evolution (v1.0)

After the clarifier produces its first `clarified-spec.md`, the orchestrator presents it to the user as a **draft for approval** before any downstream agent runs. The flow:

1. **Render the draft.** The full `clarified-spec.md` is printed to the terminal (Goal, In-scope, Out-of-scope, Assumptions, User-answers, Constraints).
2. **Present the action menu.** Below the draft:
   ```
   Proceed with this spec? [a]pprove / [e]dit / "evolve: <text>" / [c]ancel
   (auto-approve in 60s)
   ```
3. **Wait for user input** with a timeout (default 60 seconds; configurable via the `clarifier.draftTimeoutSeconds` overlay splice point).
4. **Dispatch on user response:**
   - `[a]` (single keystroke, case-insensitive) — approve as-is; sprint proceeds with the current draft.
   - `[e]` (single keystroke, case-insensitive) — open `clarified-spec.md` in `$EDITOR` (falls back to `$VISUAL`, then `vi`, then a terminal-blocking prompt explaining how to edit by hand). Wait for editor exit. Re-render the (now-edited) draft and re-prompt the action menu. The user can iterate edit cycles freely; each save touches `clarified-spec.md`.
   - `evolve: <text>` (literal `evolve:` prefix, case-insensitive, followed by additional context or new requirements) — clarifier re-runs with the original prompt + accumulated `additionalContext` + the user's evolution text. Produces a new draft; orchestrator presents it via step 1. Counts as one round; up to two evolutions allowed before forcing approve / edit / cancel.
   - `[c]` (single keystroke, case-insensitive) — abort with `UserCancelled`.
   - **Timeout reached with no input** — auto-approve with the current draft; sprint proceeds. The clarified spec records the auto-approval explicitly: "User did not respond within 60s timeout; draft auto-approved."
   - **Free-text response that doesn't match the above** — same as the partial-answer rule from the original blocker prompt: parsed per-blocker, unanswered blockers fall through to assumptions, draft regenerated and re-presented (counts as one round).

5. **Single round case.** When the clarifier produces zero blockers and no assumptions worth recording (see "No-ambiguity case" above), the draft preview is skipped entirely — the orchestrator proceeds directly to the planner. The user is not interrupted for an empty spec.

### Timeout configuration

Default 60 seconds is a reasonable interactive default; CI / scripted invocations should pass `--skip-clarification` rather than rely on the timeout. Two configuration paths:

- **Overlay splice point.** `clarifier.draftTimeoutSeconds` (integer, range `[10, 600]`, default `60`). C3 splice-point catalog gains this entry in E5's implementation PR.
- **Runtime flag.** `--clarifier-timeout=<seconds>` overrides the overlay value for one run. Useful for slow-network scenarios. Added to runtime-knobs.md alongside `--skip-clarification`. The flag enforces the same `[10, 600]` range as the overlay splice; values outside the range are rejected at flag-parse time with `InvalidTimeoutValue` and the run halts before any agent fires.

Setting the timeout to `0` (via either path) is rejected at validation time with a structured error (`InvalidTimeoutValue`) — a zero timeout is equivalent to `--skip-clarification`, which has its own dedicated flag.

### Evolution-round semantics

When the user evolves the draft, the clarifier:

1. Reads the original prompt + the accumulated `additionalContext` + the previous draft + the user's evolution text.
2. Re-runs gap detection over the combined input.
3. Produces a fresh `clarified-spec.md` that supersedes the previous one. The previous draft is preserved at `clarified-spec.md.round-N` (where `N` is the round number) so the audit trail of evolution is complete.
4. Emits a new `clarifierFinding` event series with `round: 2` (or 3) on the envelope so trace readers can distinguish rounds.

The user's evolution text becomes part of the constraints feeding subsequent rounds. The original prompt does NOT change — `raw-prompt.md` is the verbatim original; evolutions are layered on top, not rewriting history.

**Validation of evolved drafts.** The clarifier's regenerated `clarified-spec.md` after an evolution is schema-validated before the new draft is presented to the user. If validation fails (a malformed regeneration), the orchestrator emits the structured error inline, preserves the prior round's draft as authoritative, and re-presents the action menu against the prior draft. The failed regeneration counts as one round (preventing infinite retry loops within the round budget). The user can edit the prior draft, evolve again with different text, approve the prior draft, or cancel.

### Action-menu signal handling

Ctrl-C at the draft preview action menu is treated as `[c]ancel` — same outcome as typing `c` and Enter. Halts with `UserCancelled`; writes `aborted-by-user` to `progress.json.terminalReason`. This matches the user's intuition (Ctrl-C means "stop") without losing the run state — `--recover` can resume from the same draft if the user changes their mind.

Ctrl-C **inside the editor** (`[e]dit` flow) is handled by the editor itself; on editor exit (clean or signalled) the orchestrator re-validates and either re-presents the action menu (if validation passes) or re-opens the editor with the structured error (if validation fails). The user can chain Ctrl-C through both layers to fully cancel: editor exits → orchestrator re-prompts action menu → user types `[c]` (or Ctrl-C) at the menu.

### Editor flow (`[e]dit`) edge cases

When the user picks `[e]dit`, the orchestrator:

1. Resolves the editor command via the chain `$EDITOR` → `$VISUAL` → `vi`. If none resolve to an executable on `$PATH`, halts with `EditorNotConfigured` naming all three checked variables and instructing the user to set one.
2. Spawns the editor with `clarified-spec.md` as the argument.
3. Waits for editor exit. The orchestrator does **not** impose a sub-timeout on the editor — a user editing a long spec deserves time. A user whose `$EDITOR` is pathological (long-running daemon, blocks on input it never receives) can Ctrl-C, which the orchestrator catches and treats as "abandon edit; re-render previous draft and re-prompt the action menu."
4. After the editor exits cleanly, **re-validates the edited `clarified-spec.md`** against the document schema. If validation fails (broken YAML frontmatter, missing required section, malformed `assumed:` entry), the orchestrator displays the structured error inline and re-opens the editor with the same file. The user iterates until validation passes or types Ctrl-C to abandon the edit cycle.
5. On successful validation, re-renders the edited draft and re-prompts the action menu. The user can re-edit, evolve from the edited draft, approve, or cancel.

The edited spec validation is the same schema check `validateAll()` would run — there is no separate validation path. This guarantees an edited spec the user approves cannot be downstream-broken in a way the original draft wasn't.

The editor flow does NOT count as an evolution round; only `evolve: <text>` consumes a round. The user can edit any number of times within the current round.

### What v1.0's E5 round budget allows

Putting it together: a user can interact with the clarifier up to three times before being forced to commit. The bounded ceiling prevents unbounded interrogation while giving the user real iteration room. The 60-second timeout means a distracted user doesn't block the pipeline indefinitely.

This is materially more user-friendly than the originally-proposed "one round, take-it-or-leave-it" cut, at the cost of a more substantial v1.0 spec for E5. The trade is judged worth it because the clarifier is the most user-visible new surface in v1.0 and getting it wrong wastes the entire sprint downstream.

### No-ambiguity case

When the clarifier finds zero blockers and no assumptions worth recording, it produces a `clarified-spec.md` with Goal populated from the user's prompt and other sections empty. The orchestrator does not present any prompt; the sprint proceeds directly to the planner. The clarifier's `agentAttempt` event still records that it ran — its existence is part of the audit trail even when its output is minimal.

### User interaction surface

The user's only interaction with the clarifier is the **draft preview** described above. Blockers are not presented as separate batched questions; they appear in the draft as `assumed:` entries (with the clarifier's best guess) plus a visible note that the user can override the assumption via edit or evolve.

This consolidation — one interaction surface, not two — was a v1.0 design choice driven by UX feedback: separate "answer questions, then preview draft" flows asked the user to engage twice for a single goal. The unified draft preview lets the user see the proposed plan in full, then react with one of four keystrokes (approve / edit / evolve / cancel) or fall through via timeout.

A draft typically renders like this:

```
─────────────────────────────────────────────────────────────────
Clarified spec — round 1 of 3
─────────────────────────────────────────────────────────────────

Goal: Add automated tests covering the sign-in path of the login
flow, exercising the session-cookie authentication path and using
existing fixtures under tests/__fixtures__/. Password-reset is
out of scope.

In scope:
  - Unit tests for src/auth/sign-in.ts.
  - Integration test for the session-cookie issuer.

Out of scope:
  - Password-reset flow (assumed; see Assumptions).
  - JWT authentication path (assumed; see Assumptions).

Assumptions:
  - assumed: tests use vitest (active web-node stack default).
  - assumed: new tests live alongside existing tests under tests/auth/.
  - assumed: just sign-in, not password-reset (you didn't specify;
    say "evolve: include password-reset" to expand scope).
  - assumed: session-cookie path, not JWT (you didn't specify;
    say "evolve: target both" to cover both paths).

Constraints:
  - Active stack: web-node.
  - additionalContext: docs/auth-conventions.md.

─────────────────────────────────────────────────────────────────
Proceed with this spec? [a]pprove / [e]dit / "evolve: <text>" / [c]ancel
(auto-approve in 60s)
```

The example shows the visual cue for assumed-blocker resolution: each `assumed:` entry that resolved a blocker carries an inline hint about what evolution text would change the assumption. This makes the evolve mechanism discoverable without a separate help menu.

### Output: `clarified-spec.md`

A markdown document at `.gan-state/runs/<run-id>/clarified-spec.md`. Prior-round drafts are preserved alongside as `clarified-spec.md.round-1`, `clarified-spec.md.round-2`, etc. Sections:

> **F7 dependency.** Per [F7](F7-central-run-data-store-and-worktree-execution.md), run data — `clarified-spec.md`, `raw-prompt.md`, and the round-N drafts — lives in the central, repo-keyed store (`<store-root>/<repo-key>/runs/<run-id>/`), not under the project-local `.gan-state/runs/`. The `.gan-state/runs/<run-id>/` paths throughout E5 are the pre-F7 layout; E5's implementation (which lands after F7) resolves them under the central store.

- **Goal** — one-paragraph restatement of what the user asked for, after applying assumptions and any user evolution.
- **In scope** — bulleted list of work items the sprint will cover.
- **Out of scope** — bulleted list of items the user did not include, with brief justification when the clarifier resolved an ambiguity in a particular direction.
- **Assumptions** — every assumption the clarifier made, marked clearly so the user can spot one to override. Assumptions that resolved would-be blockers carry an inline evolve-hint annotation indicating what the user could type to change the assumption.
- **User actions** — chronological record of each draft preview interaction: round number, action taken (`approved` / `edited` / `evolved` / `cancelled` / `autoApprovedOnTimeout`), and supporting payload (evolution text for `evolved`; characters changed for `edited`; etc.). Empty when the user took no action (e.g. perfectly-specified prompt that produced no draft preview).
- **Constraints** — any constraints derived from `additionalContext` or stack metadata that the user should know are shaping the sprint.

The planner consumes this document as its primary input. The proposer reads it to derive contract criteria. **The evaluator does not read the clarified spec directly** — its primary input remains the contract, which the proposer derives from the clarified spec. The clarified spec → contract → evaluator chain preserves the property that "the evaluator scores against an explicit contract, not against an interpretation of intent."

### `--skip-clarification` flag

A new `/gan` skill flag that bypasses the clarifier entirely. The orchestrator (not the clarifier — the clarifier is bypassed) writes a minimal `clarified-spec.md` with:

- **Goal:** verbatim user prompt.
- **In scope, Out of scope, User actions:** empty.
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

- One `agentAttempt` event for the clarifier role per round (initial + each evolution).
- One `llmCall` event for each LLM call the clarifier makes.
- One `clarifierFinding` event per gap detected per round, carrying:
  - `class`: `selfResolved` | `assumption` | `blocker`.
  - `gapClass`: one of the five from the gap-class catalog.
  - `round`: 1 (initial), 2 or 3 (evolution).
  - `payload`:
    - For `selfResolved`: `{ resolution, source }` — what the resolution was and where the default came from (e.g. stack `testCmd`).
    - For `assumption`: `{ assumed, rationale }`.
    - For `blocker`: `{ assumedDefault, rationale }` — every blocker resolves to an assumed default in the unified-draft model; the user can override via edit or evolve.
- One `clarifierUserAction` event per draft preview interaction, carrying:
  - `action`: `approved` | `edited` | `evolved` | `cancelled` | `autoApprovedOnTimeout`.
  - `round`: which round the action terminated.
  - `payload`:
    - For `edited`: `{ editorPath, durationMs, charsChanged }`.
    - For `evolved`: `{ evolutionText }` — verbatim user evolution input.
    - For others: empty.

`clarifierFinding` and `clarifierUserAction` are new event classes added to T1's schema as part of E5's implementation PR. T1's schema PR must land first (per T1's stated landing order); E5's PR extends the schema with the new classes.

A safety-class event of class `clarifierCancelled` is emitted as a `safetyHalt` (per T1's safety-event extension point) when the user types `cancel` at the action menu.

### Sprint-budget interaction with A1

The clarifier is a single-attempt agent; A1's per-role ceilings do not apply to it. The clarifier's one attempt counts toward A1's sprint-wide budget (default 12 for v1.0). Practically, this leaves headroom for the multi-attempt agents (proposer 3, generator 3) plus the other single-attempt agents (planner, reviewer per proposal, evaluator per generator output).

### What E5 does not do

- Iterate beyond three total rounds (initial + two evolutions); the cap prevents unbounded interrogation. Confidence-scored adaptive round depth is deferred to v1.1.
- Score itself (deferred to v1.1 confidence scoring).
- Persist clarifications across runs (deferred to v1.1 user-confirmed promotion).
- Modify `additionalContext` (out of scope per the user-confirmed-only persistence rule).
- Validate (out of scope per orchestrator flow; `validateAll()` runs before E5).
- Read arbitrary file contents (out of scope per the additionalContext-only context rule).
- Re-prompt the user mid-round on parse failure (deferred; v1.0 falls through to assumptions).

## Schema additions

E5's implementation PR adds one entry to `schemas/overlay-v1.json`: `clarifier.draftTimeoutSeconds` (integer in `[10, 600]`, default `60`, both tiers, scalar cascade). Setting `0` is rejected at validation time with `InvalidTimeoutValue`; the dedicated `--skip-clarification` flag exists for the bypass case. The schema is the canonical inventory.

## Field encodings

E5's clarified-spec sections and trace-event payloads follow these encodings, common to v1.0 specs introducing new schema-bearing types and aligned with conventions established by F2 / F4 / U3:

- **Field names:** camelCase ASCII (e.g. `gapClass`, `evolutionText`, `attemptNumber`, `assumedDefault`).
- **Error codes:** PascalCase ASCII as Type-like names (e.g. `UserCancelled`, `InvalidTimeoutValue`, matching F4's `UntrustedOverlay`).
- **Event-class names and discriminator string values:** camelCase ASCII (e.g. `clarifierFinding`, `clarifierUserAction`, `selfResolved`, `assumption`, `blocker`).
- **Gap-class identifiers:** snake_case ASCII (e.g. `scope_ambiguity`, `target_of_n`, `constraint_conflict`) — these are catalog labels, not protocol values, and snake_case keeps multi-word labels legible.
- **Action values** for `clarifierUserAction.action`: camelCase ASCII (`approved`, `edited`, `evolved`, `cancelled`, `autoApprovedOnTimeout`).
- **Role IDs:** kebab-case ASCII (e.g. `gan-clarifier`).
- **terminalReason codes** (when E5 writes to `progress.json`): kebab-case ASCII (e.g. `aborted-by-user`, matching O2's convention).
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
- assumed: just sign-in, not password-reset (you didn't specify; say
  "evolve: include password-reset" to expand scope).
- assumed: session-cookie path, not JWT (you didn't specify; say
  "evolve: target both" to cover both paths).

## User actions

- Round 1: approved (single keystroke `[a]`).

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

## User actions

(empty — `--skip-clarification` bypasses the draft preview)

## Constraints

- Active stack: web-node (declared in .claude/gan/project.md).
- additionalContext from project.md: "test infrastructure: vitest with
  jsdom; fixtures live at tests/__fixtures__/"
```

A `clarifierFinding` trace event for a would-be-blocker resolved as an assumption:

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
  "round": 1,
  "payload": {
    "assumedDefault": "just sign-in (not password-reset)",
    "rationale": "Prompt mentions login flow; password-reset is a separate flow typically scoped explicitly when in scope."
  }
}
```

A `clarifierUserAction` trace event for an evolution round:

```json
{
  "envelope": {
    "sequenceNumber": 11,
    "eventType": "clarifierUserAction",
    "timestamp": "2026-05-09T09:15:43.812Z",
    "runId": "20260509-091401-c8e2"
  },
  "action": "evolved",
  "round": 1,
  "payload": {
    "evolutionText": "include password-reset"
  }
}
```

## Acceptance criteria

### Automated checks

- An ambiguous prompt produces a `clarified-spec.md` containing Goal, In-scope, Out-of-scope, Assumptions, User-answers (populated when the user explicitly evolved or edited), and Constraints sections.
- The clarifier resolves at most three would-be blockers per round into `assumed:` entries with inline evolve-hint annotations; additional gaps below the cap are downgraded to assumptions without inline hints.
- A user passing `--skip-clarification` runs straight to the planner with the minimal clarified spec defined above; `raw-prompt.md` is preserved alongside.
- The orchestrator presents the clarifier's draft as a single rendered document with an action menu and a timeout (default 60s).
- `[a]` (single keystroke, case-insensitive) approves the draft and proceeds to the planner.
- `[e]` (single keystroke, case-insensitive) opens `clarified-spec.md` in `$EDITOR` (falling back to `$VISUAL`, then `vi`); on editor exit the draft is re-rendered and the action menu re-prompts.
- `evolve: <text>` (literal `evolve:` prefix, case-insensitive, with non-empty trailing text) re-runs the clarifier with the evolution text added to context; presents an updated draft. Up to two evolutions allowed (initial + 2 = 3 rounds).
- `[c]` (single keystroke, case-insensitive) aborts with `UserCancelled`.
- A timeout reached with no user input auto-approves the current draft; the clarified spec records the auto-approval and the draft proceeds to the planner.
- The orchestrator preserves prior-round drafts at `clarified-spec.md.round-N` so the audit trail of evolution is recoverable.
- The clarifier reads `additionalContext` from U3 and does not raise gaps about anything the context already specifies (verifiable via a fixture: same prompt with vs. without context produces fewer assumed-blocker entries in the with-context case).
- The trace contains one `agentAttempt` event per round, one or more `llmCall` events per round, one `clarifierFinding` event per detected gap per round, one `clarifierUserAction` event per draft interaction, and a `safetyHalt` event of class `clarifierCancelled` when the user cancels.
- The planner reads `clarified-spec.md` as its primary input; the proposer reads it for criteria derivation; the evaluator reads only the contract.
- A perfectly-specified prompt produces a `clarified-spec.md` with empty In-scope/Out-of-scope/Assumptions sections, and the orchestrator does not present the draft preview (proceeds directly to the planner).
- The bounded directory listing the clarifier receives is filtered by active-stack scope; paths outside any active stack's globs are absent.
- Gap ranking follows the documented across-class priority order. Note that gap *detection* itself is LLM-driven and therefore non-deterministic — two runs of the same prompt may surface slightly different gaps. The acceptance contract is that *given a fixed gap set*, ranking is deterministic. Cross-run gap-detection variance is acknowledged as a known v1.0 property and is what V2's variance budget (v2.0) measures.
- Setting `clarifier.draftTimeoutSeconds: 0` is rejected with `InvalidTimeoutValue` at validation time.
- `--clarifier-timeout=<seconds>` overrides the overlay value for one run.

### Manual review checks

- User-facing question text follows the user-facing-discipline rule (no maintainer-only script names, plain prose, no Node/npm leaks).
- The five gap-class catalog entries are stable and discoverable by a v1.1 author authoring Q2.
- The single-keystroke action menu (`[a]` / `[e]` / `[c]`) and the `evolve:` literal prefix are exact-match-only; the spec does not silently accept paraphrases.
- The draft preview's visual layout (separator lines, section headings, action menu placement) is consistent across rounds so a user iterating evolutions doesn't have to re-orient each cycle.
- The `[e]dit` flow uses the standard `$EDITOR` / `$VISUAL` / `vi` fallback chain; users without any of these get a structured error explaining how to set `$EDITOR`.
- The first-run welcome banner (per the v1.0 pre-release chore) introduces the clarifier draft preview before the first one fires, so a new user is not surprised by the action menu.

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
4. (one sprint) Draft preview surface: rendering, action menu, single-keystroke parsing for `[a]` / `[e]` / `[c]`, `evolve:` literal-prefix parsing, timeout + auto-approve, prior-round preservation as `clarified-spec.md.round-N`.
4a. (one sprint) Editor integration for `[e]dit`: `$EDITOR` / `$VISUAL` / `vi` fallback, structured error when none configured, re-render after editor exit.
4b. (one sprint) Evolution rounds: clarifier re-invocation with accumulated context, round-counter enforcement, `clarifier.draftTimeoutSeconds` overlay splice and `--clarifier-timeout` flag.
5. (rides with R3 maintenance work) `--skip-clarification` flag plumbing + runtime-knobs.md update.
6. (one sprint, depends on T1 schema landing first) `clarifierFinding` trace event class + emission.
7. (one sprint) Bounded directory listing surface: snapshot extension for stack-scoped file lists.

Slices 1–4 must land in order; slice 5 can land in parallel with slice 4; slice 6 depends on T1's schema PR; slice 7 can land in parallel with slice 1 once the snapshot extension is designed.

# E6 — Pluggable evaluator role

> **Status:** targeted at v1.2. Not operative until then. Authored pre-v1.2 because the design is UX/architectural — does not depend on usage data — and the new T1 event class (`humanReview`) is additive on `run-trace-v1.json` per T1's discriminator-tolerance rule, so deferring the design does not affect the schema-freeze surface.

## Problem

The evaluator slot in the GAN loop is hardcoded to an LLM agent (`gan-evaluator`). For most sprints this is fine — the LLM produces the evidence bundle (per T1), the orchestrator reads it, the loop continues. But three classes of work are poorly served by an exclusively-LLM evaluator:

- **High-stakes sprints.** A sprint touching auth, payments, schema migrations, or production config benefits from human judgment on the verdict, not just the LLM's. The current loop has no slot for a human to substitute for the LLM evaluator without bypassing the contract entirely.
- **Calibration runs.** Comparing an LLM evaluator's verdicts against a human's on the same sprint produces V1's calibration data (per the v2.0 entry). Without a clean swap-in mechanism, calibration runs require parallel infrastructure.
- **Trust-rebuilding.** When dogfooding surfaces a class of evaluator misjudgement, the user wants to disable the LLM evaluator for one sprint, hand-review, and feed the result back into the loop the same way the LLM would. A binary "trust the LLM evaluator or don't run /gan" choice is too coarse.

Today the only way to substitute human judgment is to abandon `/gan` for that sprint. E6 makes the evaluator role pluggable at the contract boundary so a human can fill the slot without disturbing planner / proposer / generator / orchestrator code paths.

E6 is the next entry under the **E** (agent integration) phase code, after [E5](E5-spec-clarification.md). Where E5 inserts a clarifier between user prompt and planner, E6 adds a substitution point at the evaluator boundary.

## Proposed change

### `--human-eval` runtime flag

A new top-level `/gan` flag (parsed by SKILL.md alongside `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`). When set, the orchestrator runs the loop normally up to and including the generator, then **pauses** at the evaluator boundary. Instead of spawning `gan-evaluator`, the orchestrator:

1. Writes a stub evaluator-evidence-bundle file at the expected path (per T1) with all `criteria[]` entries pre-populated from the contract but with empty `verdict` and `evidence` fields.
2. Opens that file in the user's editor (per `$EDITOR` or a configured fallback) with a header comment naming the contract, the diff, and the plan.
3. Waits for the user to fill in verdicts and save.
4. Validates the resulting file against `evaluator-evidence-bundle-v1.json` (per T1's schema). If invalid, surfaces the validation error and re-opens the editor.
5. Once valid, resumes the loop as if the LLM evaluator had produced the bundle.

The user fills the same fields an LLM evaluator would: `verdict`, `evidence.traceEventRefs`, `evidence.reproductionCommand`, `evidence.deltaFromContract` (when applicable). The schema is the contract; humans and LLMs are interchangeable producers.

### `humanReview` trace event class

T1's event taxonomy gains a new event class, `humanReview`, added via T1's additive-discriminator rule (no `run-trace-v1.json` schema bump). The class records:

- `eventType: "humanReview"`
- `role: "gan-evaluator"` (the role being substituted)
- `userIdentity: <string>` — operator-provided identifier (env var, `gan` config, or interactive prompt). Stored only locally per T1's privacy contract; never transmitted off-machine.
- `editorOpenedAt`, `editorClosedAt` — RFC 3339 UTC timestamps.
- `bundleArtifactPath` — the same `outputArtifactPath` an `agentAttempt` event would have carried.
- `disposition` — enum: `"completed"` | `"abandoned"` | `"validationRetried"`.

The `humanReview` event sits in the same trace stream as `agentAttempt`, `llmCall`, and `toolCall` events. A reader can answer "which evaluator verdicts on this run came from a human?" by filtering for `humanReview` entries.

### Same evaluator-evidence-bundle contract

E6 does not introduce a new artifact shape. The human writes the **same** `sprint-{N}-feedback-{attempt-letter}.json` file the LLM evaluator would have written, validating against `schemas/evaluator-evidence-bundle-v1.json` (per T1). This is the load-bearing design choice: every downstream consumer of the bundle (the orchestrator, recovery via O2, V1's calibration harness in v2.0) treats human and LLM verdicts identically.

The bundle's `criteria[].name` fields are pre-filled from the sprint's contract — the user fills `verdict`, `evidence`, etc. The pre-population removes the cognitive load of "what was I supposed to score?" and keeps the join-key invariant (per T1) intact.

### Editor integration

Editor selection follows standard POSIX precedence: `$VISUAL` > `$EDITOR` > a built-in fallback. The fallback is platform-aware: `vim` on Linux, `nano` if `vim` is unavailable, `open -t` (TextEdit) on macOS. The orchestrator does NOT prescribe a specific editor; users who prefer VS Code, JetBrains, etc. set `$EDITOR` accordingly.

The opened file carries a header comment block summarising the run state:

```jsonc
// Sprint N evaluator review — fill in `verdict` and `evidence` for each criterion.
// Save and quit when complete; the orchestrator validates the file before resuming.
//
// Contract:    .gan-state/runs/<run-id>/sprint-{N}-contract.json
// Diff:        git -C <worktree> diff <baseCommit>..HEAD
// Trace:       .gan-state/runs/<run-id>/trace/
// Plan:        .gan-state/runs/<run-id>/sprint-{N}-evaluator-plan.json
// Schema:      schemas/evaluator-evidence-bundle-v1.json
//
// To abandon the review (no verdict produced; sprint halts), close the editor
// without saving. The orchestrator distinguishes "saved-empty" from "abandoned."
{
  "sprintNumber": 2,
  "attemptLetter": "A",
  "criteria": [
    { "name": "tls_required_for_sensitive_traffic", "verdict": "", "evidence": {} },
    { "name": "input_validation_on_request_body",   "verdict": "", "evidence": {} },
    ...
  ]
}
```

JSONC (JSON-with-comments) header is stripped before validation; the saved file must validate as plain JSON. Editors that strip comments on save are tolerated.

### Validation retry loop

If the user saves an invalid bundle (missing field, unknown verdict enum, malformed `traceEventRefs`), the orchestrator surfaces the validation error inline and re-opens the editor with the user's last input preserved. The retry counts against a configurable ceiling (default 5); reaching the ceiling halts the sprint with `HumanEvalAbandoned`.

The `validationRetried` disposition on the `humanReview` event records each retry; a sprint that takes 4 retries is auditable.

### What E6 does not do

- Replace the LLM evaluator wholesale. The default `/gan` invocation still uses `gan-evaluator`. E6 is opt-in via `--human-eval`; the LLM path is the common case.
- Provide a UI beyond the editor. Rich review interfaces (web UI, IDE plugin, mobile app) are out of scope for v1.2; the editor surface is the lowest-effort substrate. A v2.0+ extension may add structured-review UIs as separate specs.
- Allow partial human review (some criteria human, others LLM). The slot is binary per sprint: either the human fills the bundle or the LLM does. Mixed-source bundles confuse the join keys downstream.
- Coordinate multiple human reviewers. v1.2 is single-reviewer; multi-reviewer consensus is a v2.0+ extension if usage justifies it.
- Train the LLM evaluator from human verdicts. Calibration data is V1's territory in v2.0; E6 produces the data, V1 consumes it.
- Write to overlay or stack files. The human review is per-run state (zone 2), not configuration.

### Recovery and replay

A sprint paused at the human-review boundary is recoverable via O2's `--recover` flow. If the editor is interrupted (user closes the terminal, system reboots), the partial bundle is preserved at its expected path; `--recover` re-opens the editor with the partial input intact.

A completed human-reviewed sprint is replayable in the same way as an LLM-reviewed sprint. The trace's `humanReview` event records the bundle's identity; replay reads the bundle the same way it reads an LLM-produced one.

## C3 amendments

E6 introduces two new overlay splice points:

| Splice point | Type | Default | Tier scope |
|---|---|---|---|
| `humanEval.editorFallback` | string | platform-aware (see "Editor integration") | both tiers |
| `humanEval.maxValidationRetries` | integer (positive) | 5 | both tiers |

Follows C4's scalar cascade rule.

## T1 amendments

E6 introduces one new trace event class. T1's discriminator-tolerance contract permits this without a `run-trace-v1.json` schema bump — readers built for v1.0 tolerate the unknown event type per T1's forward-compat invariant.

| Event class | Discriminators | Owner |
|---|---|---|
| `humanReview` | `disposition`: `"completed"` \| `"abandoned"` \| `"validationRetried"` | E6 |

T1's spec text gains a forward-reference to E6 in the event-taxonomy section in the same PR that lands E6's implementation.

## Field encodings

Standard per A1 / T1 / E5 conventions:

- **Field names:** camelCase ASCII.
- **Error codes:** PascalCase ASCII (e.g. `HumanEvalAbandoned`).
- **Discriminator string values:** camelCase ASCII (e.g. `validationRetried`).
- **Role IDs:** kebab-case ASCII.
- **Timestamps:** RFC 3339 UTC with millisecond precision.
- **Paths in references:** relative POSIX from the trace root.

## Examples

A successful human review:

```json
{
  "envelope": {
    "sequenceNumber": 47,
    "eventType": "humanReview",
    "timestamp": "2026-09-15T14:23:45.123Z",
    "runId": "20260915-141201-a3f2"
  },
  "role": "gan-evaluator",
  "userIdentity": "thomas@example.com",
  "editorOpenedAt": "2026-09-15T14:18:02.001Z",
  "editorClosedAt": "2026-09-15T14:23:44.987Z",
  "bundleArtifactPath": "sprint-2-feedback-A.json",
  "disposition": "completed"
}
```

A `HumanEvalAbandoned` error:

```yaml
errorCode: HumanEvalAbandoned
sprintNumber: 2
attemptLetter: A
retries: 5
ceiling: 5
lastValidationError: "criteria[3].verdict: must be one of [pass, fail, blocked, skipped]"
```

## Acceptance criteria

### Automated checks

- `/gan --human-eval` against a project paused after generator completion opens an editor with the pre-filled bundle.
- A user filling all `verdict` and `evidence` fields and saving produces a bundle that validates against `evaluator-evidence-bundle-v1.json`.
- A user closing the editor without saving produces a `humanReview` event with `disposition: "abandoned"` and halts the sprint.
- A user saving an invalid bundle re-opens the editor with the last input preserved; the retry count increments on the `humanReview` event.
- Reaching the validation-retry ceiling halts the sprint with `HumanEvalAbandoned`.
- A completed human review writes the same `sprint-{N}-feedback-{attempt-letter}.json` shape an LLM evaluator would have written.
- The trace contains a `humanReview` event but no `agentAttempt` event for `gan-evaluator` on the human-reviewed attempt.
- A sprint resumed via `--recover` preserves the partial bundle and re-opens the editor.
- Setting `humanEval.editorFallback` in the user overlay overrides the platform default.

### Manual review checks

- The header comment block in the opened editor obeys the framework's error-text discipline.
- The schema reference in the header points at the published `evaluator-evidence-bundle-v1.json` per F3.
- Audit log readability: a reviewer can tell from the trace alone whether a verdict came from a human or an LLM, and who.

## Dependencies

- **F1** — zone semantics; the bundle file lives in zone 2 (run state).
- **F2** — structured-error model; E6 emits `HumanEvalAbandoned` via the existing F2 channel.
- **F3** — schema authority for the new C3 splice points.
- **C3** — `humanEval.*` overlay namespace.
- **T1** — `humanReview` event class added via additive-discriminator rule; same `evaluator-evidence-bundle-v1.json` artifact shape.
- **E1** — orchestrator that pauses at the evaluator boundary.
- **E3** — evaluator pipeline harness; the deterministic plan output is included in the editor's header references.
- **O2** — recovery; partially-filled bundles are recoverable.

E6 has no dependency on V1 (v2.0). V1 reads from E6's output if both ship, but does not gate it.

## Bite-size note

Sprintable as:

1. (one sprint) Editor integration: spawn editor via `$VISUAL` / `$EDITOR` / fallback; pre-populated bundle template; header comment block.
2. (one sprint) Validation loop: validate saved bundle against `evaluator-evidence-bundle-v1.json`; retry on failure; preserve last input.
3. (one sprint) Trace integration: `humanReview` event class added to T1; emission at editor-open and editor-close.
4. (one sprint) Recovery integration: O2's `--recover` re-opens the editor on interrupted reviews.
5. (rides with R3 maintenance) `humanEval.*` overlay splice points + `--human-eval` runtime flag + runtime-knobs.md update.

Slices 1–4 are sequential; slice 5 lands alongside slice 1's runtime parsing.

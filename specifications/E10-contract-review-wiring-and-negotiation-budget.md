# E10 — First-pass contract-review wiring & negotiation budget

## Problem

The sprint contract is supposed to lock only after the contract-reviewer approves the proposer's draft. The shipped orchestrator never wires that gate: `skills/gan/SKILL.md` step 10 spawns planner → proposer → generator → evaluator, with the contract-reviewer appearing **only** inside E8's renegotiation loop (step 4). `agents/gan-contract-reviewer.md` instructs the agent to write a verdict file (`sprint-{N}-review.json`, `{sprintNumber, verdict, notes}`) that **no consumer reads** — SKILL.md names no spawn point, no filename, and no decision rule for the first-pass review. Two consequences, both observed in the run corpus (`~/.gan-runs-data`, BR-004/BR-006):

1. **Filename and protocol anarchy.** The LLM orchestrator improvises the gate per run: three different verdict filenames across runs, and two runs with no contract review at all (no proposer/reviewer trace events between planner and generator).
2. **Ceiling exhaustion surfaced as the user-visible failure.** When the gate does run, each `revise` verdict respawns the proposer; run `…b030` reached `gan-contract-proposer: 3, gan-contract-reviewer: 3` inside sprint 1 — the proposer's seed per-role ceiling — so the next attempt-start check halts the sprint as `LoopDetected` ("first sprint not passing review"). E9's stricter first-pass review (blocker on unresolved script names) raises the revise rate, so landing E9 without this spec makes first-sprint halts *more* likely.

A1 is shipped and immutable; its ceilings and budget are correct for thrash-bounding the generator. The defect is that draft→review negotiation rounds — a *designed, convergent* protocol — are accounted as if they were thrash.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — wires the shipped contract-reviewer role into the shipped sprint loop; reuses E8's cap/terminal-reason patterns and the trace event-class mechanism A1/E8 established.
2. **Composable?** Yes — the verdict artifact + schema become the substrate E9's checks write into, F9 validates, and V1 (v2.0) measures.
3. **Owns durable structured state?** Yes — the per-round verdict artifacts under the zone-2 run dir, plus the `negotiationRound` progress field.
4. **Fits existing lanes?** Yes — mirrors E8's renegotiationCap/off-budget-role precedents rather than inventing new safety semantics.
5. **Stackable?** Yes — every later contract-quality check (Q2 taxonomy, A5 reproducibility) rides the now-wired gate.

## Proposed change

### 1. The first-pass negotiation protocol (SKILL.md step 10, made explicit)

Between the proposer and the generator, the orchestrator runs a bounded draft→review loop:

1. **Proposer writes** `sprint-{N}-contract-draft.json` (unchanged; counts as a proposer `agentAttempt`, per-role ceiling applies as today).
2. **Orchestrator spawns the contract-reviewer** (fresh-context framing per E9) with the draft, the clarified spec, the snapshot, and base-commit code access. The reviewer writes its verdict to **`sprint-{N}-contract-review-{k}.json`** — `{k}` the 0-based round index — validating against the new `contract-review-v1` schema (below). The filename's hook arm ships in H4.
3. **Orchestrator consumes the verdict:**
   - `verdict: "approved"` → the orchestrator locks the draft as the canonical `sprint-{N}-contract.json` (revision 0) and proceeds to the generator.
   - `verdict: "revise"` → the orchestrator respawns the proposer with the verdict's `issues[]` as input; round index increments; loop repeats while `k < negotiationCap`.
   - `verdict: "rejected"`, or `revise` when the cap is already reached → the orchestrator invokes the new `writeFailedContractRejected` MCP tool, marking the run terminal with `terminalReason: "failed-contract-rejected"`. Same shape and guards as E8's `writeFailedEvaluationRejected`: a first-class **rejection** (the gate said no, recoverable via `--recover` after the user adjusts the spec/prompt), never laundered into `LoopDetected`.
4. **Missing/invalid verdict is a protocol error, not a judgment call.** If the reviewer exits without writing a schema-valid verdict file at the canonical path, the orchestrator re-spawns the reviewer once; a second failure halts the run with the existing `ValidationFailed` structured-error path naming the expected filename. The orchestrator never infers a verdict from prose stdout.

`progress.json.status` reads `"negotiating"` during rounds (existing O2 value — first-pass negotiation and E8 renegotiation share the status; they are distinguished by `contractRevision` being absent/0 vs > 0).

### 2. Negotiation accounting — off-budget reviewer, capped rounds

Mirroring E8's off-budget independent reviewer (the lived precedent for "derivative role, not a thrash source"):

- **`negotiationCap`** — new overlay field `safety.negotiationCap` (default **2**: an initial draft plus at most two revise rounds), threaded additively through `EffectiveSafetyConfig` / `SafetyOverlayBlock` / `resolveEffectiveSafetyConfig` exactly as E8 threaded `renegotiationCap`. A1's `checkRoleCeiling`/`checkSprintBudget` are not edited.
- **The contract-reviewer goes off-budget.** Its audits emit a new **`contractReview` trace event class** (additive on `run-trace-v1`, wired in the three places `independentReview` was: schema, `TraceEvent` union, `KNOWN_EVENT_TYPES`), **not** budget-counted `agentAttempt` events. Payload: `{ sprintNumber, round, pass: "first-pass" | "renegotiation", verdict, issueCount }`. The reviewer is structurally bounded 1:1 by proposer attempts (which stay budgeted, ceiling 3) plus the cap, so removing it from the budget creates no unbounded role. Its `llmCall` events still carry cost into `aggregateSprintSummary`/O3 rollups, same as the independent reviewer.
- **Proposer accounting is unchanged** — ceiling 3 ≥ 1 + negotiationCap, so a cap-respecting negotiation can never trip the proposer ceiling; the ceiling continues to backstop a misbehaving loop.
- **Why not raise the seed budget instead:** the budget's job is bounding within-revision thrash (A1); inflating it to absorb designed negotiation would weaken that bound for every role. Removing a derivative role from the count is the precedented, narrower change.

### 3. Reviewer prompt + retirements

`agents/gan-contract-reviewer.md` is rewritten (`M`) on top of E9's edits: the verdict filename becomes `sprint-{N}-contract-review-{k}.json` (the unconsumed `sprint-{N}-review.json` instruction is retired), the output shape is pinned to the `contract-review-v1` schema, and the prompt states the round/caps contract (the reviewer never tracks rounds itself; the orchestrator passes `round` in). SKILL.md's step 10 and "Renegotiation loop" sections gain the explicit protocol above (renegotiation-round audits write the same artifact with `pass: "renegotiation"`). Retirement rows land at merge.

## Schema additions

- **`schemas/contract-review-v1.json`** (new, bundled): `{ schemaVersion, sprintNumber, round, pass: "first-pass" | "renegotiation", verdict: "approved" | "revise" | "rejected", issues: [{ severity: "blocker" | "warning" | "advisory", criterion?, claim, evidencePointer? }], notes }`. Pins E9's single-key verdict vocabulary.
- **`overlay-v1.json`**: additive `safety.negotiationCap` (integer ≥ 0, default 2) — in place, no version bump, per the additive-stays-`vN` ruling.
- **`run-trace-v1.json`**: additive `contractReview` event class (three-place wiring as above).
- **`progress-v1.json` consumers**: the `failed-contract-rejected` terminalReason value and the `negotiationRound` field (orchestrator-written). F9's progress-schema completeness pass absorbs both (cross-referenced there).

## Acceptance criteria

1. **Wiring greps.** `grep -n 'sprint-{N}-contract-review' skills/gan/SKILL.md` matches in step 10 and the renegotiation section; `grep -c 'sprint-{N}-review.json' agents/gan-contract-reviewer.md skills/gan/SKILL.md` returns 0.
2. **Verdict consumption is deterministic.** A prompt-structure test asserts SKILL.md documents exactly the three verdict branches plus the invalid-verdict re-spawn-once rule, and that no branch infers a verdict from stdout.
3. **Schema round-trip.** Fixture verdicts for each `verdict` value validate against `contract-review-v1`; a `decision`-keyed fixture fails.
4. **Off-budget accounting.** Given a synthetic trace with 3 proposer `agentAttempt` events and 3 `contractReview` events plus the standard single-attempt roles, `checkSprintBudget` fed by the reconstruction sees the proposer's 3 and **no** reviewer attempts; the run does not halt. (Asserts the event-class split, not an A1 edit.)
5. **Cap semantics.** A simulated negotiation that reaches `negotiationCap` with a `revise` verdict terminates via `writeFailedContractRejected` with `terminalReason: "failed-contract-rejected"` and `terminal: true`; the tool is a no-op when the cap has not fired. `LoopDetected` does not fire on that path.
6. **Three-place event wiring.** `contractReview` appears in `run-trace-v1.json`, the `TraceEvent` union, and `KNOWN_EVENT_TYPES` (the BR-precedented scanner test pattern).
7. **Recovery legibility.** A run interrupted mid-negotiation (status `"negotiating"`, no canonical contract yet) resumes through O2's existing `negotiating` dispatch branch and re-enters the proposer at the recorded round (asserted on the dispatch prose + a reconstruction test).
8. **Lints green.** `house-rules`, `lint-no-spec-ref`, `lint-no-stack-leak`, `lint-error-text` all exit 0 on the rewritten prompts.

## Version bump: minor

New MCP tool (`writeFailedContractRejected`), new bundled schema, additive overlay/run-trace schema edits — installed-package changes; the PR minor-bumps `package.json`.

## Dependencies

- **E9** (draft, in flight on `feature/fix-order-plan-tier5-impl`) — verdict-key normalisation and first-pass review checks; E10 wires what E9 sharpened. Land E9 first.
- **H4** — the hook arm for `sprint-{N}-contract-review-{k}.json`; without it the verdict write is denied.
- **E8 / A1 / O2 / T1** (shipped) — the renegotiation loop, safety semantics, `negotiating` status, and trace mechanics this spec composes with; cross-referenced, never edited.
- **F9** (forward) — routes the verdict write through the schema-gated boundary; E10's artifact is authored to be F9-legible (schemaVersion stamp, catalog row already present via H4).

## Bite-size note

One PR, two slices: (1) schema + `writeFailedContractRejected` + `contractReview` event class + safety-config threading, with unit tests (~1 sprint); (2) SKILL.md step-10 protocol + reviewer-prompt rewrite + prompt-structure tests (~0.5 sprint). The dogfood check is the audit's verification path: a fresh `/gan` run whose sprint 1 locks a contract through an **approved** verdict and reaches the evaluator without a ceiling halt.

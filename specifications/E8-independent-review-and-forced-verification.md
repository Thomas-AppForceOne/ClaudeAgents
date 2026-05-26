# E8 — Independent adversarial review & forced verification

## Problem

The framework's central promise is an *adversarial* loop: a skeptical evaluator that rejects code which does not meet the bar, forcing the generator to revise. In v1.0 dogfooding to date, that loop has never been adversarial. Across 18 evaluation bundles spanning 5 runs — ~247 individual criterion verdicts — the evaluator has produced **zero failing verdicts and zero `blocked` verdicts**, and every sprint passed on its first attempt. The retry path has never engaged. A separate review agent, run by the operator after each `/gan` run, reliably finds real defects — some major — that the evaluator passed. The quality bar is currently set by manual post-review, not by the framework.

This is structural, not a tuning miss. Five compounding causes:

1. **Conformance, not correctness.** The evaluator scores only the pre-written contract criteria (its prompt forbids scoring anything else). The contract is authored by the proposer *from the spec, before the code exists*, so it cannot enumerate the specific defect the generator will introduce. Code that satisfies criterion X while harbouring a bug X never imagined passes.
2. **Same model on both sides.** Generator and evaluator both run `opus`. Same-model self-evaluation shares the generator's blind spots and anchors on its self-reported success.
3. **Tolerant threshold.** Most criteria pass at 7/10, and the rubric defines 7–8 as *"Good. Core functionality works correctly with minor issues."* The gate is configured to admit minor issues.
4. **Verification is reasoned, not run.** The evaluator is told to "delegate every deterministic decision to evaluator-core" — but there is no call path to it (R7 fixes the capability), and nothing forces execution, so checks are largely reasoned about.
5. **A closed loop.** Proposer → generator → evaluator all read the same contract; no independent notion of correctness ever enters.

E8 fixes all five. The PROJECT_CONTEXT convention is explicit and load-bearing: *"The LLM evaluator's PASS/FAIL on contract criteria remains the SOLE authoritative gate — quality findings inform but never corrupt the adversarial signal."* E8 therefore introduces an independent reviewer as a **criterion source feeding contract renegotiation**, not a parallel gate.

**Critical correction (the renegotiation loop does not yet exist).** Earlier framing assumed E8 could "compose the contract-renegotiation path that already exists." It does **not** exist in the shipped product: `skills/gan/SKILL.md` contains no renegotiation/retry/loop-back step; the agent prompts *reference* renegotiation as something "the orchestrator" does, but no orchestrator step implements it. **E8 therefore OWNS and fully specifies that loop** (below). It does not depend on H2 (which is operator-driven steering, a different mechanism) or on Q2 (which later *generalises* the evidence-bundle representation of findings); E8 ships its own minimal renegotiation trigger in v1.0.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — it composes the contract-proposer, contract-reviewer, evaluator, and R7's evaluator-core/trace tools, and it *defines* the renegotiation loop those roles were written to assume. It adds no parallel gate.
2. **Composable?** Yes — the independent-review role is a pluggable seam E6 (v1.2, human evaluator) and C6 (v2.0, per-role model routing) build on; V1/V2/V3 (v2.0) measure it.
3. **Owns durable structured state?** Yes — the review artifact and the versioned re-locked contracts, all under the zone-2 run dir.
4. **Fits existing lanes?** Yes — honours the sole-gate rule, the measurement-vs-gating split, and the delta/ratchet integrity-probe convention.
5. **Stackable / non-terminal?** Yes — the reviewer role and the no-new-defects criterion class are reused every sprint and extended by later specs.

Passes all five. This is the v1.0 headline: the mechanism that makes the gate able to reject. **Measurement** of how well it rejects is deferred to v2.0 (V1/V2/V3).

## Proposed change

Five coordinated changes. (1) is the new input; (2) is the loop E8 owns; (3)–(5) harden the existing gate.

### 1. Independent review role (new agent)

A new agent — `gan-reviewer-independent` — spawned after the generator commits and before the evaluator's verdict, reviewing the sprint's diff the way a skeptical senior engineer reviews a pull request **cold**:

- **Contract-free.** It does not read the sprint contract; it reviews the diff for correctness, security, regressions, edge cases, error handling, concurrency — the defect classes a pre-written contract cannot enumerate.
- **Different model from the generator** (the minimal seed of C6's per-role routing; defaults to a capable model ≠ the generator's). Per the *re-simplify on model upgrades* convention, this split encodes a capability assumption and is subject to the model-bump audit.
- **Fresh context** — not given the generator's self-report, so it cannot anchor on the generator's confidence.
- **Output: findings, each with a severity** (`blocker` | `warning` | `advisory` per the measurement-vs-gating convention), concrete evidence (file:line, a deterministic `reproductionCommand`), and a `suggestedCriterion` — a specific, testable restatement the proposer can adopt.

It never marks a sprint pass/fail. It is a criterion source.

### 2. The renegotiation loop (owned by E8, specified in SKILL.md)

E8 adds this loop to the orchestrator's per-sprint flow:

1. Generator commits its attempt.
2. `gan-reviewer-independent` reviews the diff → writes `sprint-{N}-independent-review-{attempt}.json`.
3. **Finding validation (two guards, by finding kind):** before any finding becomes a criterion it must pass a well-foundedness guard appropriate to its kind — because the reviewer's most valuable findings are exactly the ones with no runnable reproduction:
   - **Command-reproducible findings** carry a deterministic `reproductionCommand` (e.g. a failing test, a grep for a banned pattern). The orchestrator runs it via R7 and **drops** the finding if it does not reproduce. Reproduction is the arbiter.
   - **Inspection findings** — correctness/readability/security defects with no runnable reproduction (e.g. "a lock is held across an `await` at `src/x.ts:42`", "this error is swallowed", "off-by-one in the loop bound") — carry instead a precise **evidence pointer** (`file:line` + the specific claim). These are the classes a pre-written contract cannot enumerate, so they are **not** auto-dropped. Their guard is two-layered: the **contract-reviewer's well-foundedness audit** **plus** the evaluator's §5 discretion (it may still score the resulting criterion as pass if the flagged code is in fact correct). **E8 explicitly adds the well-foundedness duty to the contract-reviewer's charter** — today `gan-contract-reviewer.md` audits only specificity/comprehensiveness/scope; E8's rewrite of it (listed under Schema and surface additions) adds the duty to "read the cited code and reject a finding-derived criterion whose claim the code does not actually exhibit." This is a *factual* check (is the defect real?), distinct from the existing *well-formedness* check (is the criterion specific/in-scope?); the rewrite states both. **Caveat (honest):** this guard is itself an `opus`-class judgment, so it *relocates* rather than *eliminates* leniency risk — a real defect now requires the different-model independent reviewer, the contract-reviewer, and the evaluator to *all* miss it (three independent passes, two on different models), which is strictly stronger than the evaluator alone, but its reliability is measured at scale only by V1 (see Deferred-by-design). A finding that is neither command-reproducible nor carries a checkable `file:line` evidence pointer is **not silently dropped**: it routes to the **advisory tier** (surfaced and spun into a follow-up task per the measurement-vs-gating split), so the reviewer's hardest-to-pin output — e.g. "this module's whole concurrency model is wrong" — is preserved and visible rather than discarded, just not made a gating criterion.

   This is the false-positive guard: reproduction is the arbiter where a command exists; an audited, code-anchored evidence pointer is the arbiter where it does not. Neither kind can become a criterion on the reviewer's say-so alone.
4. If any surviving `blocker`/`warning` finding maps to no existing contract criterion, the orchestrator triggers a **renegotiation round**: the contract-proposer adds criteria from the surviving findings' `suggestedCriterion`; the contract-reviewer audits the *added* criteria for specificity/scope **and may reject a finding-derived criterion as ill-formed**.
5. The expanded contract is **re-locked at a new revision** (see lifecycle below). The generator receives it as feedback and produces the next attempt; the loop repeats from step 1.
6. The **evaluator** scores the current contract revision and remains the **sole gate** (below).

`advisory` findings never trigger renegotiation; they route to the next generator attempt and/or a follow-up task per the advisory tier.

### Contract lifecycle under renegotiation (re-lock, not mutate)

The shipped model is `sprint-{N}-contract-draft.json` → reviewer approves → `sprint-{N}-contract.json` (**locked**), and the reviewer is forbidden from mutating a locked contract. E8 does **not** mutate a locked contract. A renegotiation round produces a **new locked revision**:

- Contracts are versioned: `sprint-{N}-contract-r{revision}.json`, revision `0` = the initial lock, each renegotiation round increments. The prior revision is never edited in place (consistent with the no-mutate rule; each revision goes through its own draft→audit→lock).
- Each evaluator evidence bundle and each independent-review artifact records the `contractRevision` it scored. The **T1 join-key invariant** (`criteria[].name` must match a criterion in *the contract revision the bundle scored*) holds per revision — a bundle joins against its recorded revision, never against a later one.
- The active revision is recorded in `progress.json`; recovery (O2) reconstructs it from the highest-numbered **locked** contract for the sprint. A renegotiation round's new revision is committed atomically (its draft is fully audited, then locked); a crash *before* the lock leaves the prior revision authoritative, and recovery ignores an unlocked partial draft exactly as it ignores any pre-lock draft — so a mid-renegotiation crash never strands the sprint on a half-built contract.

### Bounding thrash and the A1 budget (must-fix)

Adding a reviewer pass plus renegotiation rounds materially increases per-sprint work, and a naive loop can thrash (a fix introduces a new defect the reviewer flags → another criterion → …). A1's edit-oscillation guard watches *generator fingerprints*, not *criteria growth*, so it does not catch this. E8 adds an explicit bound:

- **A per-sprint renegotiation cap** (default `2` rounds; resolved through the same effective-safety config as A1's ceilings, overridable via overlay). It is distinct from A1's per-role/ sprint-wide attempt ceilings.
- **The A1 sprint budget is re-baselined for the reviewer-in-loop topology.** The reviewer is a once-per-attempt role (no per-role ceiling) but its attempts count toward the sprint budget; the budget's headroom term is increased to account for the reviewer and the bounded renegotiation rounds. (The exact new default lands with the implementation and is tuned by the post-v1.0 dogfooding audit; A1's seed values were already flagged as un-tuned.)
- **Hitting the renegotiation cap with unresolved `blocker` findings fails the sprint *as an evaluation failure*, not a `LoopDetected` halt.** This is the key distinction: an unresolved real defect must surface as "the gate rejected this work" (a contract failure the user sees, recoverable and re-runnable), not be laundered into a thrash-halt. `LoopDetected` remains reserved for genuine non-convergence (A1); E8's cap produces a first-class *rejection*.

### 3. Forced deterministic verification

The evaluator MUST obtain its plan from R7's `buildEvaluatorPlan` tool and **execute** every command the plan lists (test, lint, build, audit, secrets scan, doc-lint) via R7, capturing real output and exit codes; a command-backed criterion carries the **executed** result in its evidence, not a described expectation. Deterministic results are measurement feeding the evaluator's evidence; they gate only through criteria. **Failure-mode contract:** a command the plan marks absent (its `absenceSignal` fires) follows the existing `absenceMessage` warning path and does **not** auto-fail the criterion for tool absence; a non-deterministic or timing-out command is recorded as such and does not auto-fail on flakiness alone — consistent with the shipped evaluator's absence handling.

### 4. No-new-defects criterion class + threshold recalibration

- **No-new-defects class (proposer default), delta/ratchet semantics** per the integrity-probe convention: *no new defect in the changed files vs the base ref*, *no regression in prior-sprint coverage*, and *every surviving `blocker` finding is resolved*. Worse-than-base fails; absolute thresholds are not used.
- **Threshold recalibration.** The 7/10 "minor issues acceptable" band is removed for the **correctness, security, and no-new-defects** classes: their default threshold rises and the rubric for them is rewritten so "minor issues remain" is **not** a pass. Functionality/UX criteria keep the existing default.

### 5. Sole-gate preservation, stated precisely (not a fig leaf)

The independent reviewer **expands the contract's coverage**; the evaluator still **judges** every criterion with full discretion and remains the only thing that fails a sprint:

- The evaluator MAY score a finding-derived criterion as **pass** (if, on inspection, the flagged code is actually correct) — a benign finding does not force a failure.
- The contract-reviewer MAY **reject** a finding-derived criterion as ill-formed, and a finding whose reproduction does not reproduce is dropped before it ever becomes a criterion (step 3) — so the evaluator is not a notary stamping reviewer-authored verdicts.
- A defect fails a sprint only when the evaluator, exercising that discretion, scores a criterion below its threshold. That is the sole gate, unchanged. The reviewer raises *what gets asked*; the evaluator decides *whether it passed*.

### What E8 does not do

- It does **not** add a second gate, and it does **not** reduce the evaluator to a pass-through (the discretion in §5 is explicit and tested).
- It does **not** edit shipped E1/E3 — it rewrites the product prompt files (`agents/gan-evaluator.md`, `agents/gan-contract-proposer.md`, `agents/gan-contract-reviewer.md`) and `skills/gan/SKILL.md`, and adds the reviewer prompt; the shipped specs are cross-referenced.
- It does **not** change evaluator-core's logic (E3) — it makes *consuming and executing* the plan mandatory, via R7.
- It does **not** fold findings into the evidence bundle — that representation is Q2 (v1.1), which generalises E8's v1.0 artifact; E8 owns its own trigger semantics now.

## Schema and surface additions

- **`schemas/independent-review-v1.json`** (new): `{ sprintNumber, attemptLetter, contractRevision, findings: [{ id, severity, category, kind: "command"|"inspection", file, line, description, reproductionCommand?, reproduced?, evidencePointer?, suggestedCriterion }], summary: { blockers, warnings, advisories, dropped } }`. `kind: "command"` findings carry `reproductionCommand` + `reproduced`; `kind: "inspection"` findings carry `evidencePointer` (`file:line` + claim) and are audited rather than run (per §2 step 3).
- **Versioned contract artifact** `sprint-{N}-contract-r{revision}.json` and a `contractRevision` field on the evaluator evidence bundle and the review artifact. Per pre-v1.0 schema discipline, adding `contractRevision` to `evaluator-evidence-bundle-v1` is an additive field; the implementing PR applies F3's versioning rule.
- **`agents/gan-reviewer-independent.md`** (new prompt). **Rewrites (`M`):** `agents/gan-evaluator.md`, `agents/gan-contract-proposer.md`, `agents/gan-contract-reviewer.md`, `skills/gan/SKILL.md` (the renegotiation loop). Retirement rows land at merge.
- **New knobs:** the per-role reviewer model and the renegotiation cap — land in [`runtime-knobs.md`](runtime-knobs.md) and the `safety.*` overlay block in the implementing PR.
- SKILL.md's new renegotiation sections carry D1 status markers.

## Acceptance criteria

### Automated checks

- **The gate rejects a contract-satisfying defect (the core fix).** A planted-defect fixture — a diff that satisfies its initial contract but contains a deliberate out-of-contract bug — drives: the review surfaces it as a `blocker` whose `reproductionCommand` reproduces → renegotiation adds a criterion → the evaluator scores it below threshold → the sprint **fails evaluation** (a rejection, not a `LoopDetected` halt). (Today this fixture passes; post-E8 it must fail-as-rejection.)
- **Defect-catch floor (blocking, not a release chore).** Against a small planted-defect suite (multiple defect classes), the reviewer-plus-renegotiation must surface and fail on at least a defined fraction; the suite and floor are part of the E8 PR, not deferred. This is the only empirical check that the reviewer is not as lenient as the evaluator.
- **False-positive guard, both finding kinds.** A planted unfounded **command** finding (whose `reproductionCommand` does not reproduce) is dropped; a planted unfounded **inspection** finding (whose `evidencePointer` cites code that does not exhibit the claimed defect) is rejected by the contract-reviewer's well-foundedness audit. The unfounded-inspection case is part of the **calibrated** defect-catch suite (not a single fixture), so the contract-reviewer's reject-the-unfounded behaviour is exercised against several decoys, not one. Neither kind becomes a criterion; the sprint is not forced into spurious work. A finding with neither a reproducing command nor a checkable evidence pointer routes to the **advisory tier** (surfaced, not silently dropped).
- **Sole-gate discretion.** A test asserts (a) an independent-review `blocker` alone does not mark a sprint failed unless the evaluator scores a resulting criterion below threshold; and (b) the evaluator can pass a finding-derived criterion it judges benign.
- **Forced execution.** Every command-backed criterion carries a real captured exit code/output, not a described expectation; an `absenceSignal` command follows the warning path and does not auto-fail.
- **Re-lock lifecycle + join-key.** A renegotiated sprint produces `sprint-{N}-contract-r1.json` without editing `-r0`; each evidence bundle's `contractRevision` joins against the matching revision and the join-key invariant holds.
- **Thrash bound.** A constructed thrash scenario hits the renegotiation cap and fails as an evaluation failure (not `LoopDetected`); the sprint budget is not silently exceeded.
- **Model split.** The reviewer's resolved model differs from the generator's by default.

### Manual review checks

- `gan-reviewer-independent.md` reviews the **diff, not the contract** — verified by prompt inspection.
- `gan-evaluator.md`'s rubric no longer admits "minor issues" as a pass for correctness/security.
- New prompt + orchestrator surfaces honour the F4 error-text discipline and pass `lint-no-stack-leak`.

### Deferred-by-design

- **Reviewer accuracy/variance and threshold tuning** — V1/V2 (v2.0); E8 ships the mechanism and the defect-catch floor, V1 measures it at scale.
- **The contract-reviewer's reject-the-unfounded rate on inspection findings** — measured at scale by V1 (v2.0), like the independent reviewer's catch rate. v1.0 ships the mechanism plus the calibrated unfounded-inspection cases in the defect-catch suite; it does not pretend the `opus`-class audit is benchmarked yet (see §2 step 3 caveat).
- **Findings represented inside the evidence bundle** — Q2 (v1.1) generalises E8's artifact.
- **Reviewer-verdict reproducibility (pinned temperature/seed)** — A5 (v1.2).

## Dependencies

- **R7** (hard) — forced plan execution and the reviewer's reproduction-gated validation are impossible without it. E8 cannot land before R7.
- **E1, E3** — the evaluator/proposer/reviewer roles and evaluator-core. Shipped; cross-referenced, not edited.
- **A1** — the attempt budget E8 re-baselines and the `LoopDetected` semantics E8 stays distinct from. Shipped.
- **O2** — the recovery flow that must reconstruct the active contract revision; E8's re-lock artifacts are designed to be recovery-legible (O2 ships in v1.0; see roadmap).
- **C1** — template-instantiation for the no-new-defects criterion class.

## Bite-size note

One coordinated PR, sliced so the core gate-rejection AC is reachable early:

1. `gan-reviewer-independent` agent + `independent-review-v1` schema + reproduction-gated finding validation (~1 sprint).
2. The renegotiation loop in SKILL.md + versioned re-lock lifecycle + thrash cap (~1–2 sprints). Slices 1–2 make the planted-defect AC fail-as-rejection.
3. Proposer/reviewer rewrite: no-new-defects class, threshold recalibration, finding-derived-criterion audit (~1 sprint).
4. Evaluator rewrite: forced plan execution via R7 + recalibrated rubric (~1 sprint).

~4–5 sprints. The planted-defect fixture and the defect-catch floor gate the PR: until they fail-as-rejection (correctly) and clear the floor, E8 has not done its job.

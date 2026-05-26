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
- **Same top-tier model as the generator (e.g. `opus`), run independently.** Its independence comes from **fresh context + contract-free framing**, *not* from a different — and therefore weaker — model. Mandating "≠ the generator's model" would force the reviewer onto a *less* capable model than the work it reviews, which is backwards for a skeptical-senior-engineer role. A different or additional model is an **optional** escalation (C6's per-role routing, v2.0), never a forced downgrade. The shared-blind-spot risk that same-model review carries is mitigated by the context independence here and, at scale, by variance sampling (V2, v2.0).
- **Fresh context** — not given the generator's self-report or reasoning, so it cannot anchor on the generator's confidence. This is the primary independence lever (it does not depend on a model difference). Throughout this spec the **independent reviewer** reviews *code*; the **contract-reviewer** (shipped, a different role) audits the *contract* — "reviewer" unqualified means neither, so both are always named in full.
- **Output: findings, each with a severity** (`blocker` | `warning` | `advisory` per the measurement-vs-gating convention), concrete evidence (file:line, a deterministic `reproductionCommand`), and a `suggestedCriterion` — a specific, testable restatement the proposer can adopt.

It never marks a sprint pass/fail. It is a criterion source.

### 2. The renegotiation loop (owned by E8, specified in SKILL.md)

E8 adds this loop to the orchestrator's per-sprint flow:

1. Generator commits its attempt.
2. `gan-reviewer-independent` reviews the diff → writes `sprint-{N}-independent-review-{attempt}.json`.
3. **Finding validation (two guards, by finding kind):** before any finding becomes a criterion it must pass a well-foundedness guard appropriate to its kind — because the reviewer's most valuable findings are exactly the ones with no runnable reproduction:
   - **Command-reproducible findings** carry a deterministic `reproductionCommand` (e.g. a failing test, a grep for a banned pattern). The orchestrator runs it via R7 and **drops** the finding if it does not reproduce. Reproduction is the arbiter.
   - **Inspection findings** — correctness/readability/security defects with no runnable reproduction (e.g. "a lock is held across an `await` at `src/x.ts:42`", "this error is swallowed", "off-by-one in the loop bound") — carry instead a precise **evidence pointer** (`file:line` + the specific claim). These are the classes a pre-written contract cannot enumerate, so they are **not** auto-dropped. Their guard is two-layered: the **contract-reviewer's well-foundedness audit** **plus** the evaluator's §5 discretion (it may still score the resulting criterion as pass if the flagged code is in fact correct). **E8 explicitly adds the well-foundedness duty to the contract-reviewer's charter** — today `gan-contract-reviewer.md` audits only specificity/comprehensiveness/scope; E8's rewrite of it (listed under Schema and surface additions) adds the duty to "read the cited code and reject a finding-derived criterion whose claim the code does not actually exhibit." This is a *factual* check (is the defect real?), distinct from the existing *well-formedness* check (is the criterion specific/in-scope?); the rewrite states both. **Caveat (honest):** this guard is itself an `opus`-class judgment, so it *relocates* rather than *eliminates* leniency risk — a real defect now requires the contract-free independent reviewer, the contract-reviewer's audit, and the evaluator to *all* miss it (three independent passes with independent context), which is strictly stronger than the single evaluator pass alone, but its reliability is measured at scale only by V1 (see Deferred-by-design). A finding that is neither command-reproducible nor carries a checkable `file:line` evidence pointer is **not silently dropped**: it routes to the **advisory tier** (surfaced and spun into a follow-up task per the measurement-vs-gating split), so the reviewer's hardest-to-pin output — e.g. "this module's whole concurrency model is wrong" — is preserved and visible rather than discarded, just not made a gating criterion.

   This is the false-positive guard: reproduction is the arbiter where a command exists; an audited, code-anchored evidence pointer is the arbiter where it does not. Neither kind can become a criterion on the reviewer's say-so alone.
4. If any surviving `blocker`/`warning` finding maps to no existing contract criterion, the orchestrator triggers a **renegotiation round**: the contract-proposer adds criteria from the surviving findings' `suggestedCriterion`; the contract-reviewer audits the *added* criteria for specificity/scope **and may reject a finding-derived criterion as ill-formed**.
5. The expanded contract is **re-locked at a new revision** (see lifecycle below). The generator receives it as feedback and produces the next attempt; the loop repeats from step 1.
6. The **evaluator** scores the current contract revision and remains the **sole gate** (below).

`advisory` findings never trigger renegotiation; they route to the next generator attempt and/or a follow-up task per the advisory tier.

### Contract lifecycle under renegotiation (re-lock, not mutate)

The shipped model is `sprint-{N}-contract-draft.json` → reviewer approves → `sprint-{N}-contract.json` (**locked**), and the reviewer is forbidden from mutating a locked contract. E8 does **not** mutate a locked contract. A renegotiation round produces a **new locked revision**:

- **The canonical filename stays `sprint-{N}-contract.json`** — it always holds the *latest locked revision*. This is non-negotiable: the **shipped** `evaluator-evidence-bundle-v1` schema hardcodes its join key as "the corresponding `sprint-{N}-contract.json`" (lines 81/178) and O2's resume reads that exact path. An earlier draft proposed renaming it to `sprint-{N}-contract-r{rev}.json`; that would break the shipped join key *and* O2, so it is **not** renamed.
- Prior revisions are **archived as siblings** `sprint-{N}-contract.r{k}.json` (k = 0, 1, …) for the audit trail; the live join target is always the unsuffixed canonical file. The contract-reviewer never mutates a locked file — each renegotiation round writes a fresh draft, audits it, then **atomically replaces** the canonical file (snapshotting the superseded one to `.r{k}.json` first), consistent with the no-mutate rule.
- The active revision index is tracked in **`progress.json`** (orchestrator-owned run state), **not** as a field on the evaluator evidence bundle. So E8 makes **no change to `evaluator-evidence-bundle-v1`**: its existing `criteria[].name` → canonical-contract join key is untouched, and the pre-v1.0 schema-versioning convention conflict (below) does not arise. Recovery (O2) reconstructs the active revision from `progress.json` and the canonical locked file.
- A renegotiation round's canonical-file replacement is atomic; a crash *before* the swap leaves the prior canonical contract authoritative, and recovery ignores an unlocked partial draft exactly as it ignores any pre-lock draft — so a mid-renegotiation crash never strands the sprint on a half-built contract.

### Bounding thrash and the A1 budget (must-fix)

Adding a reviewer pass plus renegotiation rounds materially increases per-sprint work, and a naive loop can thrash (a fix introduces a new defect the reviewer flags → another criterion → …). A1's edit-oscillation guard watches *generator fingerprints*, not *criteria growth*, so it does not catch this. E8 adds an explicit bound:

- **A per-sprint renegotiation cap** (default `2` rounds; resolved through the same effective-safety config as A1's ceilings, overridable via overlay). It is distinct from A1's per-role/ sprint-wide attempt ceilings.
- **The renegotiation cap is accounted *separately* from A1's sprint budget — by a concrete trace mechanism, not a free "reset".** Earlier drafts asserted a renegotiation round "resets the per-revision accounting A1's budget sees" with no mechanism. But the shipped `checkSprintBudget` (`src/safety/sprint-budget.ts`) sums *every* attempt with no revision concept, `reconstructRecoveryState` is whole-trace, and A1/T1 are immutable — so the scoping must be built *additively*, without editing them:
  1. **`agentAttempt` trace events gain an optional `contractRevision` field** — added to `run-trace-v1.json` *in place* per the resolved schema ruling (the same way A1 added the `safetyHalt` class to `run-trace-v1` with no version bump). The orchestrator stamps it with the active revision when emitting via R7's `emitTraceEvent`.
  2. **A new pure helper `reconstructRevisionState(traceRoot, contractRevision)`** — new code that **E8 ships** as a tool in R7's trace tool group: R7 *establishes* that group (it ships first), and E8 *adds this tool* after, together with the `contractRevision` field it filters on (R7, shipping first, cannot depend on a field E8 introduces). It does **not** edit the shipped whole-trace `reconstructRecoveryState`; it filters `agentAttempt` events by `contractRevision` and returns the per-role tally for that revision only.
  3. The orchestrator feeds that **revision-scoped** tally into the shipped, unchanged `checkSprintBudget` and `checkRoleCeiling` (pure functions that sum what they are given). The budget therefore sees only the current revision's attempts — the scoping lives at the call site, never inside A1. So A1's budget bounds *one revision's* thrash (genuine within-revision non-convergence still halts as `LoopDetected`), and the renegotiation cap bounds the *number of revisions*. Without this, a 2-round renegotiation (every counted role × rounds) would exceed the default budget and fire `LoopDetected` *before* the cap — the exact wrong-halt the next bullet forbids.
  4. **Recovery-safe, no separate baseline:** the `contractRevision`-tagged `agentAttempt` events *are* the per-revision counter (trace-as-only-counter preserved), and the active revision is in `progress.json`. `--recover` rebuilds the scoped tally via `reconstructRevisionState(traceRoot, contractRevision)`, so a recovered run cannot mis-fire `sprintBudgetExceeded` from a prior revision's attempts. O2 AC 29 tests exactly this.
  5. **Which roles the budget counts (stated, not left implicit).** `gan-reviewer-independent` runs once per generator attempt, and each renegotiation round re-runs the proposer + contract-reviewer; all of them emit `contractRevision`-tagged `agentAttempt` events exactly as every existing role does — trace-as-only-counter, so recovery reconstructs them and none are off-book. They therefore count in the revision-scoped `checkSprintBudget` sum, and the new reviewer gets its own `DEFAULT_ATTEMPT_CEILINGS` entry under `checkRoleCeiling` like any other role. The per-revision budget headroom (A1's existing `MAX_ATTEMPTS_BUDGET_HEADROOM` margin, resolved through the same effective-safety config) is sized with the **full** counted role set in view — generator + independent-reviewer + evaluator + (per round) proposer + contract-reviewer — so within a revision the **renegotiation cap**, not the sprint budget, is the binding bound on revision count.
- **Hitting the renegotiation cap with unresolved `blocker` findings fails the sprint *as an evaluation failure*, not a `LoopDetected` halt.** An unresolved real defect must surface as "the gate rejected this work" (a contract failure the user sees, recoverable and re-runnable), not be laundered into a thrash-halt. The orchestrator marks the run terminal with **`terminalReason: "failed-evaluation-rejected"`** — a kebab-case reason E8 *declares* and O2 (which owns the `terminalReason` enum and ships after E8) absorbs into the enum; it is semantically a *rejection* (the gate said no), distinct from `aborted-*` (an abort the user initiated) and from `failed-loop-detected` (non-convergence). `LoopDetected` stays reserved for genuine non-convergence (A1); E8's cap produces a first-class rejection with its own reason code.

### 3. Forced deterministic verification

The evaluator MUST obtain its plan from R7's `buildEvaluatorPlan` tool and **execute** every command the plan lists (test, lint, build, audit, secrets scan, doc-lint) via R7, capturing real output and exit codes; a command-backed criterion carries the **executed** result in its evidence, not a described expectation. **For a stack with a docker module active, this includes the container-health gate** (the Docker-module-wiring slot — M4): the evaluator runs R7's `dockerCheckContainerHealth` and gates the relevant criterion on whether the built container actually boots — closing the "evaluator gates on real `ContainerHealth`" aspiration that otherwise had no spec. Container-health joins the forced-execution list conditionally (only when a docker module is active for the stack), exactly like the per-stack `auditCmd`/`docLintCmd` entries. Deterministic results are measurement feeding the evaluator's evidence; they gate only through criteria. **Failure-mode contract:** a command the plan marks absent (its `absenceSignal` fires) follows the existing `absenceMessage` warning path and does **not** auto-fail the criterion for tool absence; a non-deterministic or timing-out command is recorded as such and does not auto-fail on flakiness alone — consistent with the shipped evaluator's absence handling.

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
- **Contract revision artifacts:** the canonical `sprint-{N}-contract.json` (latest locked, unchanged join target) plus archived siblings `sprint-{N}-contract.r{k}.json`; the active revision index lives in `progress.json`. **No change to `evaluator-evidence-bundle-v1`** — `contractRevision` is `progress.json` run state, not a bundle field.
- **Schema-versioning ruling (resolved, was a flagged conflict).** The conflict between PROJECT_CONTEXT's "pre-v1.0, *any* schema change bumps `schemaVersion`" and the shipped schemas' "additive stays v1" is **resolved in favour of additive-stays-v1**, grounded in lived precedent: A1 added the `safetyHalt` event class to the shipped `run-trace-v1.json` with **no** `run-trace-v2` and no migration tool. The ruling (recorded in the roadmap § "Schema-versioning ruling", flagged there for spec-validator to fold into PROJECT_CONTEXT under the single-writer rule): **pre-v1.0, additive changes — new optional field, new enum value, new event class — edit the `vN` file in place; only a field-rename/semantic-change forces `vN+1`** (with migration tooling). This unblocks every schema touch below; none needs a version bump.
- **`agents/gan-reviewer-independent.md`** (new prompt). **Rewrites (`M`):** `agents/gan-evaluator.md`, `agents/gan-contract-proposer.md`, `agents/gan-contract-reviewer.md`, `skills/gan/SKILL.md` (the renegotiation loop). Retirement rows land at merge.
- **Overlay `safety.renegotiationCap`, added in place (per the ruling above).** The renegotiation cap is a persistent `safety.*` overlay knob. The `safety` block (`schemas/overlay-v1.json`, `additionalProperties: false`) today allows `{attemptCeilings, oscillationDetection, sprintBudget}`; `renegotiationCap` is **added to that block additively, editing `overlay-v1.json` in place — no `overlay-v2`, no migration tool** (same class as A1's in-place `run-trace-v1` addition). The **reviewer-model selection** is a per-role config knob (the C6 seed) landing in [`runtime-knobs.md`](runtime-knobs.md). Both listed here so the schema impact is explicit.
- **`run-trace-v1` additive field + new helper (the §"Bounding thrash" budget-scoping mechanism).** `agentAttempt` gains an optional `contractRevision` field, added to `run-trace-v1.json` in place per the ruling. A new pure `reconstructRevisionState(traceRoot, contractRevision)` (new code, **not** an edit to the shipped `reconstructRecoveryState`) ships **in E8's PR** as a tool added to R7's trace tool group — R7 establishes the group (it ships first), E8 adds this tool (with the `contractRevision` field it filters on) after, since R7 cannot depend on a field that does not exist until E8. Neither A1's `checkSprintBudget`/`checkRoleCeiling` nor T1's `reconstructRecoveryState` is modified.
- **`progress.json` fields E8 writes (absorbed by O2's schema):** the `failed-evaluation-rejected` `terminalReason` value and the `contractRevision` field. E8 is the writer and ships before O2 authors the strict `progress-v1.json`; O2's schema must include both or E8-renegotiated runs fail validation. Cross-referenced in O2's Dependencies + AC 29. (`terminalReason` is a loose string in shipped code today, so E8 writes the value fine until O2's schema lands.)
- SKILL.md's new renegotiation sections carry D1 status markers.

## Acceptance criteria

### Automated checks

**CI has no LLM** (per R7), so any assertion that requires the live independent-review → renegotiation → evaluator loop is a **release-gate / dogfood** verification (see "Release-gate verification" below), *not* a CI check — this includes the LLM-judgment parts of the false-positive and sole-gate checks below (e.g. the contract-reviewer rejecting an unfounded *inspection* finding, the evaluator passing a *benign* finding-derived criterion). The CI-runnable checks here verify the **mechanics**.

- **False-positive guard, both finding kinds.** A planted unfounded **command** finding (whose `reproductionCommand` does not reproduce) is dropped; a planted unfounded **inspection** finding (whose `evidencePointer` cites code that does not exhibit the claimed defect) is rejected by the contract-reviewer's well-foundedness audit. The unfounded-inspection case is part of the **calibrated** defect-catch suite (not a single fixture), so the contract-reviewer's reject-the-unfounded behaviour is exercised against several decoys, not one. Neither kind becomes a criterion; the sprint is not forced into spurious work. A finding with neither a reproducing command nor a checkable evidence pointer routes to the **advisory tier** (surfaced, not silently dropped).
- **Sole-gate discretion.** A test asserts (a) an independent-review `blocker` alone does not mark a sprint failed unless the evaluator scores a resulting criterion below threshold; and (b) the evaluator can pass a finding-derived criterion it judges benign.
- **Forced execution.** Every command-backed criterion carries a real captured exit code/output, not a described expectation; an `absenceSignal` command follows the warning path and does not auto-fail.
- **Re-lock lifecycle + join-key.** A renegotiation round writes a fresh draft, then **atomically replaces the canonical `sprint-{N}-contract.json`**, snapshotting the superseded revision to a `sprint-{N}-contract.r{k}.json` sibling. The evidence bundle is **unchanged** — its `criteria[].name` join still targets the unsuffixed canonical file (no per-revision bundle field; `contractRevision` lives in `progress.json`), and the join-key invariant holds. A crash before the swap leaves the prior canonical contract authoritative. (Verifies the body's "re-lock, not rename" model; the dash-`r1` naming and per-revision bundle join of an earlier draft are **not** implemented — they would break the shipped join key and O2.)
- **Thrash bound.** A constructed thrash scenario hits the renegotiation cap and fails as an evaluation failure (not `LoopDetected`); the sprint budget is not silently exceeded.
- **Model parity + context independence.** The reviewer's resolved model **equals** the generator's by default — no forced downgrade (§1) — and its independence is verified *structurally*: it is spawned with fresh context and contract-free framing, not via a model difference. (A different/additional model is C6's optional v2.0 escalation, never mandated here. The earlier "model differs by default" AC is retired — it contradicted §1 and would force the reviewer onto a weaker model than the work it reviews.)

### Release-gate verification (dogfood — CI has no LLM)

- **The gate rejects a contract-satisfying defect, and the defect-catch floor holds.** A planted-defect fixture — a diff that satisfies its initial contract but hides a deliberate out-of-contract bug — must drive the full loop: independent review surfaces a `blocker` whose `reproductionCommand` reproduces → renegotiation adds a criterion → the evaluator scores it below threshold → the sprint **fails evaluation** (a rejection, not a `LoopDetected` halt). And against a small multi-class planted-defect **suite**, reviewer-plus-renegotiation must surface-and-fail on at least a defined fraction. This is E8's **only** empirical proof that the gate can reject and that the reviewer is not as lenient as the evaluator. It **requires the live LLM loop, which CI cannot run** (no LLM — per R7), so it is **v1.0-blocking but proven by the release-gate dogfood protocol** (roadmap § "Pre-release chores and release gate", item 2 — the same planted-defect suite and fraction), never asserted as a CI result. The suite and floor ship in the E8 PR.

### Manual review checks

- `gan-reviewer-independent.md` reviews the **diff, not the contract** — verified by prompt inspection.
- `gan-evaluator.md`'s rubric no longer admits "minor issues" as a pass for correctness/security.
- New prompt + orchestrator surfaces honour the F4 error-text discipline and pass `lint-no-stack-leak`.

### Deferred-by-design

- **Reviewer accuracy/variance and threshold tuning** — V1/V2 (v2.0); E8 ships the mechanism and the defect-catch floor, V1 measures it at scale.
- **The contract-reviewer's reject-the-unfounded rate on inspection findings** — measured at scale by V1 (v2.0), like the independent reviewer's catch rate. v1.0 ships the mechanism plus the calibrated unfounded-inspection cases in the defect-catch suite; it does not pretend the `opus`-class audit is benchmarked yet (see §2 step 3 caveat).
- **Findings represented inside the evidence bundle** — Q2 (v1.1) generalises E8's artifact.
- **Reviewer-verdict reproducibility (pinned temperature/seed)** — A5 (v1.2).

## Version bump (install-affecting)

E8 adds the bundled `independent-review-v1` schema, the `reconstructRevisionState` MCP tool, and additive `run-trace-v1` / `overlay-v1` fields — installed-package changes that take effect only via `install.sh`'s version-gated `npm install -g .`. Per the pre-1.0 install-version bump discipline (roadmap § "Pre-release chores and release gate"), E8's implementation PR **bumps `package.json` `version`**. This is the framework package version and is **distinct from** the `run-trace`/`overlay` `schemaVersion`, which stays `v1` (the fields are additive, per the schema-versioning ruling).

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

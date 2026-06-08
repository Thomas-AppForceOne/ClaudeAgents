# Bug-fix order plan

Drafted **2026-06-08** from the verified bug-report corpus ([VERIFICATION-SUMMARY.md](VERIFICATION-SUMMARY.md)).

Of 16 reports: 11 confirmed, 3 partially-valid, 2 not-reproducible. **14 are actionable; 2 should be closed.**

This is a sequencing proposal, not a roadmap commitment. Each phase is a coherent fix unit; within a phase the items are ordered by dependency.

> **Roadmap cross-reference — read first.** Several bugs in this plan turn out to be artefacts of work the roadmap has already deferred (BR-001), planned for v1.1 (BR-009 in Q2), or possibly designed-in (BR-010). See [ROADMAP-CROSS-REFERENCE.md](ROADMAP-CROSS-REFERENCE.md) for the per-bug analysis. The phases below carry **TIER** annotations from that document; before authoring any fix, check the tier — Tier 1 and Tier 3 items should *not* become new fix specs.

## Operating principles

1. **Pair coordinated bugs together.** Three pairs in this corpus are two symptoms of the same root gap. Fixing one half of a pair without the other leaves the orphaned half re-emerging in the next sprint.
2. **Foundational write-boundary work first.** Schema and observability infrastructure pays back compoundingly; later fixes (typed channels, digest stamping) want it in place.
3. **Don't fix what isn't broken.** The two `not-reproducible` reports should not generate implementation work — only triage outcomes.
4. **One-issue-per-spec.** Several confirmed bugs implicate multiple framework files (prompt + SKILL.md + H1 hook + schema). Decide the canonical answer once, then push it through every layer in the same spec — not as four sequential specs.

## Phase 0 — Close-outs (no implementation)

These are not framework defects; they should be marked closed in this pass.

| Bug | Action | Reason |
|---|---|---|
| **BR-013** | Close as `not-reproducible`. | `telemetry/config.json` is fully governed by the shipped O3 spec (PR #39). The report's "matches T4" claim is wrong — O3 and T4 are complementary specs for different artefacts. The 7 missing-file runs predate O3 merge. |
| **BR-015** | Close as `not-reproducible`. **File two new bugs** for the distinct anomalies verification surfaced: (a) bare-vs-stack-qualified naming in doc-surface criterion ids (sprints 1–5 vs sprint 6); (b) `web-node` has no `documentationSurfaces` array in the snapshot, so the proposer is generating these criteria from internalised knowledge rather than from stack declarations. | The reported per-file multiplication does not occur (sprint 4 has 4 criteria, not 8). The proposer spec mandates per-surface, not per-file. |

## Phase 1 — Foundational blockers (observability + write-boundary)

These four set up the substrate every later fix relies on. Schema-tightening passes after this become safe; without it they touch each other's terrain.

### 1A. **BR-001** — trace emission per-call-site obedience (Blocker) — **TIER 1 (accepted v1.0 gap)**

> **Roadmap status:** BR-001 is the verbatim manifestation of v1.0 known gap #4 — *"Downstream correctness compounds on trace-emission fidelity"*. The roadmap routes this to the v1.0 **release-gate workstream** (item #25, unshipped) for observation and to V1 (v2.0) for measurement. **Do not author a fix spec.** The proposals below are tractable release-gate hardenings the workstream may choose to consume, *not* a new spec to add to the v1.0 inventory.

Release-gate-time hardenings (optional, not new specs):

- Add a post-attempt orchestrator-side invariant: for every sprint listed in `progress.json`, assert at terminal that at least one `agentAttempt` event exists per executed role (generator and evaluator at minimum). On failure, write `terminalReason: "traceEmissionGap"`.
- Alternatively (stronger): wrap agent spawns in a structural emission-injection that doesn't depend on prompt obedience.
- Add a guard in `reconstructRecoveryState` for the degenerate-trace case (`agentAttempt` count == 0) so `--recover` does not silently read zero attempts.

### 1B. **BR-016** — `schemaVersion` convention (Low, but foundational) — **TIER 3 (convention add, not a runtime defect)**

> **Roadmap status:** the *Schema-versioning ruling (pre-v1.0)* in the roadmap and PROJECT_CONTEXT § *Schema discipline — additive-stays-`vN`* govern *when* schemas bump `vN` — not *which artefacts must carry a `schemaVersion` stamp*. This bug is a missing convention, not an unshipped spec. Land it as a PROJECT_CONTEXT § Conventions addition or as a small new spec, paired with the BR-002/BR-003 schema sweep.


- Decide once: bare top-level `schemaVersion` vs `envelope.schemaVersion` (telemetry pattern). Document the decision in PROJECT_CONTEXT.
- Add the stamp to `progress-v1.json`, `independent-review-v1.json`, `evaluator-evidence-bundle-v1.json` as **optional** for now (because existing conforming artefacts omit it, and existing carrying-stamp artefacts are otherwise broken).
- **Why before 1C and 1D:** they tighten the same schemas; landing the convention first prevents two passes.

### 1C. **BR-002** — `independent-review-v1` enforced at the write boundary (Blocker) — **TIER 2 (same family as obedience gap, not specifically listed)**


- Validate at the writer (orchestrator-side post-spawn read) before consumption — refuse malformed bundles with a clear error, not silent acceptance.
- Tighten validation to also cover the `reproductionCommand` safety pattern (two existing artefacts fail on this, not on missing fields).
- Audit whether `evaluator-evidence-bundle-v1` has the same gap; if so, extend this fix to cover both (cheaper than two passes).

### 1D. **BR-003** — `progress.json` schema completeness + write-boundary coverage (Blocker) — **TIER 2 (same family as obedience gap, not specifically listed)**


- Complete the schema: add `startedAt` (present in 5/8 runs, missing from schema), add a `sprints[]` array (resolving the two incompatible shapes from `1588` and `5cc0`), and decide the status of `snapshot.activeStacks` / `finalCommit`.
- Wire the orchestrator's direct JSON writes to the same `validateProgress` gate the MCP tools use. Today only `seedProgress` / `assertValidProgress` / `writeProgressFields` / `recordWorkspace` are gated; direct writes bypass them.
- Provide a graceful-read path for the 6 existing non-conforming runs (recovery and reporting need it).

**Phase 1 deliverable:** a run that emits trace events at every agent attempt, writes schema-conformant artefacts at every boundary, and stamps `schemaVersion` everywhere — verifiable by re-running the BR reproduction commands against a fresh `/gan` run and observing empty bug-output.

## Phase 2 — Contract quality pair (Highs)

Same observed defect, two pipeline roles. Either fix layer is plausible; landing both is robust.

### 2A. **BR-007** — proposer pre-flight name resolution

- Validate cited names in proposed criteria before the contract is locked. Scope for v1: `npm run X` script references (cheap, exact). Defer file paths and exported symbols to a v1.1 pass.
- Update the evaluator prompt so "intent satisfied" can no longer paper over a name miss — coordinate with this proposer change so the loop closes.

### 2B. **BR-006** — contract-reviewer fresh-context + cited-name resolution framing

- Add fresh-context / cold-read framing to `agents/gan-contract-reviewer.md`.
- Add explicit script-name resolution as a reviewer check on first-pass drafts (today the well-foundedness audit only fires on renegotiation rounds with finding-derived criteria).
- Normalise the verdict-shape: pick one of `decision` / `verdict` and update the spec; downstream consumers must not have to handle both.

## Phase 3 — Evaluator artefact pair (High + Medium)

The same artefact has two related defects. Settle the canonical name first, then stamp the digest into that one canonical file.

### 3A. **BR-004** — evaluator-output filename canonicalisation

- Pick one of `sprint-N-feedback-A.json` or `sprint-N-evidence-A.json` (today: prompt and SKILL.md say `-feedback-A.json`; disk emits `-evidence-A.json`).
- Update all three layers consistently: agent prompt (`agents/gan-evaluator.md`), `skills/gan/SKILL.md`, H1 confinement hook write-allow pattern (`H1-framework-owned-confinement-hook.md:53`).
- Refuse non-canonical variants at H1 to prevent LLM runtime deviation from re-emerging.

### 3B. **BR-008** — evaluator-prompt digest stamp

- Add an `evaluatorPromptDigest` (or `promptHash`/`promptVersion`) field to `evaluator-evidence-bundle-v1.json`. Required field, given `additionalProperties: false` is already in force.
- Have the orchestrator stamp the digest at evaluator spawn (read from the prompt file at that moment) and assert it on read.
- Coordinate the schema-version bump with the canonical-filename change so consumers see one transition, not two.

## Phase 4 — Missing typed-channel pair (Mediums)

Both are symptoms of the same gap: no sanctioned channel for evaluator captured-output / harness-condition observations. Decide the channel design once.

### 4A. **BR-009** — `harnessConditions` typed channel — **TIER 3 (fold into Q2, v1.1)**

> **Roadmap status:** Q2 (v1.1) explicitly defines an out-of-contract structured-error-code channel as a new optional top-level field on the evaluator evidence bundle, *"keyed by a Q2 error code (sharing the E5 clarifier-gap vocabulary)"*. Harness conditions are a clean fit for the Q2 vocabulary. **Do not author a separate fix spec.** Instead, fold the harness-condition class into Q2's failure-mode taxonomy when Q2 is authored.

If a v1.0 stop-gap is wanted before Q2 lands:

- Add `additionalProperties: false` to the `criterion` definition in `evaluator-evidence-bundle-v1.json` (the other surrounding shapes already have it). This stops the silent `concerns` field acceptance without committing to a channel design.

### 4B. **BR-012** — sanctioned channel for captured shell/browser output

- Either extend T1's `trace/payloads/` channel with a new event class (`capturedCommandOutput` or similar) with the captured-data blob written as a payload, or define a typed subdirectory under `trace/` for these. Whichever route, document it in T1 + SKILL.md + the evaluator prompt.
- Retire the ad-hoc `evaluator-logs/` and `evaluator-logs-B/` patterns at the evaluator-prompt level. Add an H1-level write-refusal for the legacy names so they cannot silently re-emerge.

## Phase 5 — Independent confirmed bugs

These do not pair with anything else. Order is mostly orthogonal — sequenced here by impact.

### 5A. **BR-005** — generator-objection schema + orchestrator dispatcher (High)

- Add `schemas/generator-objection-v1.json` (rewrite, not the retired E1 one).
- Add the orchestrator branch that reads the objection artefact when `OBJECTION-RAISED` is seen, hands it to the contract-proposer for a contract revision, and only re-runs the generator on the revised contract. Today the orchestrator treats the OBJECTION-RAISED stdout as just another failed attempt.
- Surface objections in `progress.json.objections[]` for cross-run analysis (depends on BR-003 schema work).
- Add an end-to-end fixture exercising the objection loop.

### 5B. **BR-010** — snapshot-freshness exception for newly shipped agents (Medium) — **TIER 4 (possibly by-design, decide first)**

> **Roadmap status:** F7's snapshot-freshness rule (shipped PR #23) does not say whether mid-run agent shipping *should* be visible to subsequent sprints. The bug report assumes it should; the verification noted no observable downstream harm in the affected E8 run (all six sprints passed first-try). **Get a by-design ruling first.** If intentional: close with a F7-clarifying note (new spec, not an edit to F7). If accidental: proceed with the snapshot-freshness exception below.

If proceeding with a fix:

- Decision: either tighten the spec to make the current behaviour explicit ("agents shipped in a sprint of a run are unavailable in subsequent sprints of that run — this is by design for safety"), or relax the snapshot-freshness rule to re-scan `agents/` between sprints when the diff added agent files.
- Verification of either choice depends on BR-001's trace fidelity (events to prove invocation / non-invocation).

### 5C. **BR-011** — `clarified-spec.md` validation (Medium)

- Pick one of: (a) create `schemas/clarified-spec-v1.json` and wire it into the orchestrator's post-clarification read; (b) implement a simpler section-presence + frontmatter lint; (c) remove the "document schema" references from `E5-spec-clarification.md` and `SKILL.md` if neither (a) nor (b) is wanted.
- Add a no-op-clarifier signal (the `5cc0` 1.0× ratio case): refuse a clarified-spec whose content is byte-identical to the source spec.

### 5D. **BR-014** — `web-node` `lintCmd` is the test runner (Low)

- Decide the canonical answer for the `web-node` stack: declare `lintCmd: eslint .` (or similar), or remove `lintCmd` entirely.
- If removed, add `absenceSignal: warning` support for `lintCmd` in `stack-v1.json` so the convention is explicit (the schema today places no constraint preventing `lintCmd === testCmd`).
- Add a lint check: warn on stack manifests where `lintCmd === testCmd` or where `lintCmd` names a known test-runner binary (`vitest`, `jest`, `mocha`, `pytest`, etc.).

## Effort estimate (rough, for sequencing only)

| Phase | Effort | Risk |
|---|---|---|
| 0 — Close-outs | Trivial | None |
| 1 — Foundational | Large | Medium (schema migrations require care for in-flight `--recover`) |
| 2 — Contract pair | Medium | Low |
| 3 — Evaluator pair | Medium | Low (mostly coordinated edits across prompt/SKILL/hook/schema) |
| 4 — Channel pair | Medium-large | Medium (decision of channel design is load-bearing) |
| 5A — Objection routing | Medium | Low (small but new orchestrator branch) |
| 5B — Snapshot freshness | Small | Low (policy decision, not code-heavy) |
| 5C — Clarified-spec | Small-medium | Low |
| 5D — lintCmd | Small | None |

Total: roughly four to six sprints if phases run sequentially. Phase 1 wants to land as one unit; the later phases can interleave or run in parallel between maintainers.

## Out of scope for this plan

- **The "fix-validated" status flip.** The verification pass closed the "Needs verification" gate. The next gate ("fix-validated") flips when each bug's symptom no longer reproduces after the corresponding fix lands. That is per-fix work, not part of this ordering.
- **Cross-run analytics tooling** (`gan health`, dashboard) — those depend on this work landing first.
- **New specs vs amendments** — PROJECT_CONTEXT § Conventions decides per-bug whether the fix amends a shipped spec (rare) or writes a new spec retiring/superseding the old. This plan is implementation order, not spec-authoring order.

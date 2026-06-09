# Roadmap cross-reference

Investigation **2026-06-08** — for each verified bug, does the roadmap (`specifications/roadmap.md`) already acknowledge the gap, plan a fix in a later release, or treat the behaviour as intentional? Several bugs are not defects to add fix specs for — they are artefacts of work the framework has explicitly chosen to defer.

The v1.0 inventory currently shows items 1–24 shipped (✅) and item 25 — **"Pre-release chores + release gate"** — **unshipped**. Several findings here are exactly the gaps the unshipped release-gate workstream is designed to *observe*, not to *fix*.

## Tier 1 — Explicitly an accepted v1.0 known gap

These should not get a fix spec. The roadmap has already decided where the work lands.

### BR-001 — Trace emission silently absent

**Roadmap entry:** v1.0 Known gaps accepted at v1.0 → *"Downstream correctness compounds on trace-emission fidelity (same root as the safety-obedience gap)."*

> "O2's recovery counter reconstruction, E8's revision-scoped budget (§ 'Bounding thrash'), and O3's cost rollup all *read* the trace — so each silently degrades or mis-fires if the markdown orchestrator skips an `emitTraceEvent` call. R7 makes emission a tool and CI proves the tool works and is called at the documented SKILL.md points; **that a real run emits every event is behaviour-verified only by the release-gate dogfood, not CI.**"

This is a verbatim description of BR-001. The roadmap also names **the release gate (item #25, unshipped)** as the surfacing mechanism:

> "trace emission, a loop-detection halt actually firing, and a `--recover` resume are each **observed** on a real run"

And the closing of the gap lands in v2.0:

> "v2.0 delivers the harness that *measures* how good that trust is. … V1 — LLM-verdict accuracy harness with confidence-calibration. … the automated end-to-end orchestrator-flow harness named as a known gap at v1.0."

**Disposition:** keep BR-001 as a *finding* against the v1.0 release-gate (item #25) — it is precisely the class of evidence item #25 is meant to collect. **Do not author a fix spec.** The orchestrator-side invariant proposed in the original report is still a reasonable hardening to consider for the release-gate workstream, but inventing a new spec for it bypasses the roadmap's "mechanism in v1.0, measurement in v2.0" decision.

## Tier 2 — Same family as the v1.0 obedience gap, not specifically listed

The roadmap's two obedience-class gaps (#3 safety-obedience, #4 trace-emission fidelity) are about the orchestrator being markdown executed by Claude. Schema-conformance of LLM-emitted artefacts is the same family of problem — Claude *can* ignore SKILL.md and the agent prompt — but the roadmap does not explicitly enumerate it. These bugs sit in the same conceptual bucket but were not pre-decided as deferred.

### BR-002 — `independent-review-v1` schema not enforced at write time

The schema (`schemas/independent-review-v1.json`) shipped in E8 (PR #35). What didn't ship is a write-boundary validator that catches when the reviewer LLM emits a non-conformant bundle. SKILL.md's "schema-valid precondition on the caller, not an enforced check" stance is the obedience-family pattern. The roadmap does not call this out specifically.

**Disposition:** treat as a genuine fix candidate. The roadmap doesn't say "this is acceptable v1.0 drift"; it just didn't pre-decide it. Foundational write-boundary work (Phase 1 in [FIX-ORDER-PLAN](FIX-ORDER-PLAN.md)).

### BR-003 — `progress.json` schema discipline

`schemas/progress-v1.json` shipped in O2 (PR #37), and the MCP write helpers (`seedProgress`, `assertValidProgress`, `writeProgressFields`, `recordWorkspace`) gate writes through the validator. The orchestrator's *direct* JSON writes do not. Same obedience-family pattern as BR-002.

**Disposition:** treat as a genuine fix candidate. Pair with BR-002 in the foundational write-boundary phase.

(The original README's filing-context claim that BR-002/BR-003 stress the "per-stack overlay overrides" v1.0 gap is loose — those bugs have nothing to do with overlay overrides. The conceptual link to the obedience gaps stands; the specific roadmap citation does not.)

## Tier 3 — Covered by a planned future spec

These bugs land in scope for spec work that is already roadmapped but not yet shipped.

### BR-009 — harness conditions in free-text `concerns`

**Roadmap entry:** v1.1 → *"Q2 — failure-mode taxonomy (structured error codes replacing free-form prose; shared vocabulary with E5's clarifier-gap codes)."* — and specifically its bullet:

> *"Evaluator-bundle follow-up — out-of-contract findings. … Q2 defines how orphan findings are surfaced — a structured out-of-contract record carried alongside the per-criterion verdicts, keyed by a Q2 error code (sharing the E5 clarifier-gap vocabulary) — plus the renegotiation-trigger semantics. Per T1's 'additive stays on v1' rule this lands as a NEW OPTIONAL top-level bundle field."*

Q2 explicitly covers the structural shape BR-009 needs (a structured top-level bundle channel keyed by error code, replacing free-form prose). The harness-condition class is not named, but it's a clean fit for the Q2 vocabulary.

**Disposition:** **fold into Q2 (v1.1)** rather than authoring a separate fix. The Phase 4 entry for BR-009 in FIX-ORDER-PLAN should be re-labelled as "Q2 scope clarification: add harness-conditions to the failure-mode taxonomy".

### BR-016 — `schemaVersion` inconsistent across artefacts

**Roadmap entry:** the *"Schema-versioning ruling (pre-v1.0)"* section in the roadmap and the matching PROJECT_CONTEXT § "Schema discipline — additive-stays-`vN`" rule. Both rulings are about *when* schemas bump `vN`, not about *which artefacts must carry a `schemaVersion` stamp*. The two are orthogonal: the bump-discipline rule is fully shipped, the artefact-stamping convention is unwritten.

This bug is therefore *not* an artefact of an unshipped spec — it's a missing convention. But it is also not a self-contained release item: the right home is either a PROJECT_CONTEXT § Conventions addition (one-fact-one-home), or a small future spec that defines the stamp convention.

**Disposition:** fix is still in scope, but it's a convention-formalisation pass, not a runtime defect. Pair with the BR-002 / BR-003 write-boundary work — they all touch the same schemas, do them in one sweep.

## Tier 4 — Possibly by-design (needs a roadmap or spec clarification, not a fix)

These look like bugs but may actually be intentional invariants — there is no roadmap entry either way.

### BR-010 — newly shipped agents not invoked in own run

**Relevant background:** F7 (Centralized run-data store + worktree-aware execution, shipped PR #23) establishes snapshot freshness — the orchestrator captures the agent/skill/schema inventory at `/gan` start and pins it for the run. There is no spec text saying "agents shipped during a sprint of a run *should* become spawnable in the next sprint of the same run." The verification ([BR-010-verification.md](BR-010-verification.md)) confirmed the mechanism works once a fresh `/gan` invocation re-captures the snapshot.

So this is one of:
- **(a) An intentional safety invariant** — pinning the agent roster for the duration of a run prevents mid-run inventory churn. If true, it should be documented in F7 prose (not by editing F7 — by a new convention-clarifying spec or a PROJECT_CONTEXT addition).
- **(b) An accidental restriction** — the spec did not think about the case of a run that ships agents. If true, F7 + the orchestrator should allow re-scanning between sprints when the sprint diff added agent files.

The roadmap does not pick a side, and the bug report assumes (b). The verification observation that all six E8 sprints passed first-try (so even with the reviewer live, nothing would have escalated) means there is **no observable downstream harm from the current behaviour** on that one run.

**Disposition:** before authoring any fix, the user (or maintainer) should rule whether this is (a) by design or (b) an accidental restriction. A "fix" assumption is premature.

## Tier 5 — Genuine bugs the roadmap does not address

Bugs whose root cause is not roadmapped, not covered by a planned future spec, and not plausibly by design.

| BR | Class | Why not on roadmap |
|---|---|---|
| **BR-004** | Filename drift across SKILL.md / prompt / H1 hook | LLM runtime deviation from a stable prompt; H1's write-allow pattern is too permissive. Not on roadmap. |
| **BR-005** | Generator-objection no schema, no orchestrator dispatcher | Legacy `objection.schema.json` retired during E1 with "rewrite or drop" — the rewrite never landed. No roadmap entry plans the dispatcher. |
| **BR-006** | Contract-reviewer rubber-stamps first-pass drafts | E8 (PR #35) shipped the contract-reviewer rewrite; this is a coverage gap in the shipped E8, not deferred work. README's filing-note acknowledges this. |
| **BR-007** | Proposer doesn't validate cited names | Same as BR-006 — E8 didn't put pre-flight name validation on the proposer side. |
| **BR-008** | Evaluator-prompt digest missing from evidence bundle | T1 (PR #19) shipped the bundle schema with `additionalProperties: false`; no digest field exists at any layer. No planned spec adds one. |
| **BR-011** | `clarified-spec.md` has no structural validation | E5 (PR #30) shipped the clarification phase; structural enforcement is mentioned in spec prose but no schema or lint exists. E5 round 2 (v1.1) covers adaptive depth, not structural validation. |
| **BR-012** | `evaluator-logs/` undocumented parallel channel | Ad-hoc sidecar evolved outside T1/R7's trace-channel discipline. Single-project-root scope (workshop-site only). No roadmap entry plans a captured-output channel. |
| **BR-014** | `web-node` `lintCmd: "vitest run"` | Stack-file content defect (not the v1.0-deferred *overlay* override mechanism). Trivial config fix. |

## Bugs already closed by the verification pass

- **BR-013** — not-reproducible. O3 (PR #39) governs `telemetry/config.json` correctly; the report's T4 attribution was wrong.
- **BR-015** — not-reproducible. The per-file duplication does not occur; verification surfaced two distinct anomalies (bare-vs-qualified criterion naming; `web-node` has no `documentationSurfaces` in the snapshot) which should be filed as their own bugs.

## Summary

| Tier | Count | BRs |
|---|---|---|
| 1 — Accepted v1.0 known gap (release-gate workstream) | 1 | BR-001 |
| 2 — Same family as obedience gap, not specifically listed | 2 | BR-002, BR-003 |
| 3 — Covered by a planned future spec | 2 | BR-009 (Q2), BR-016 (convention pass) |
| 4 — Possibly by-design (clarification needed) | 1 | BR-010 |
| 5 — Genuine bugs unaddressed by roadmap | 8 | BR-004, 005, 006, 007, 008, 011, 012, 014 |
| Closed by verification | 2 | BR-013, BR-015 |

## Implications for the fix-order plan

The Phase 0–5 sequence in [FIX-ORDER-PLAN.md](FIX-ORDER-PLAN.md) is unchanged for Tier 5 (the 8 genuine bugs). But Tiers 1–4 need different dispositions:

1. **BR-001 (Tier 1)** should move *out* of Phase 1 in FIX-ORDER-PLAN. It is not a fix candidate — it's an item for the unshipped v1.0 release-gate workstream (roadmap item #25). The orchestrator-side invariant proposed in the bug report can still be considered as a release-gate hardening, but it is not a new spec to author. **Phase 1A in FIX-ORDER-PLAN should be marked "see release-gate workstream, not a fix spec."**
2. **BR-002 + BR-003 (Tier 2)** stay in Phase 1 of FIX-ORDER-PLAN — the roadmap does not specifically defer them, and they are tractable hardening work.
3. **BR-009 (Tier 3)** moves *out* of Phase 4 — the work belongs in Q2 (v1.1). The Phase 4 pair becomes BR-012 alone (or BR-012 paired with a Q2 scope note for BR-009).
4. **BR-016 (Tier 3)** stays in Phase 1 (foundational schema-discipline pass) but is reframed: it is a convention-formalisation, not a defect.
5. **BR-010 (Tier 4)** should pause for a maintainer decision before Phase 5B opens. If by-design: close with a F7-clarifying note. If accidental: proceed with the snapshot-freshness exception.

A revised FIX-ORDER-PLAN reflecting these adjustments would materially shorten Phase 1 (BR-001 lifts out, BR-016 reframes as a convention add) and shift Phase 4 (BR-009 lifts out to Q2's scope).

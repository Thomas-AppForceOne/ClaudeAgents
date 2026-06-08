# BR-008 — Evidence files carry no evaluator-prompt digest; mid-run protocol changes are invisible

**Status:** Needs verification
**Severity:** Medium
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0` (E8 — sprint 1 evidence is prose; sprints 2-6 carry `reproductionCommand` + `deltaFromContract`)
**Filed:** 2026-06-08

## Description

E8's evaluator-prompt rewrite landed in sprint 5 of the very run that introduced it. As a result, the run's own evidence files have two distinct shapes:

- **Sprint 1**: free-form `{name, score, threshold, verdict, evidence}` with evidence as prose. Zero `reproductionCommand` entries (counted via `grep -c '"reproductionCommand"'`).
- **Sprints 2-6**: `{name, verdict, evidence: {reproductionCommand, deltaFromContract: {expected, observed}}}`. 17–26 `reproductionCommand` entries per file.

The protocol change was invisible from the artifacts alone — nothing in the evidence file says "graded under evaluator prompt version X." An operator (or downstream `gan run summary` consumer) cannot tell whether two evidence files are comparable without diffing them by hand.

This problem will recur every time the evaluator prompt is materially edited. With renegotiation now firing in real runs, the same problem applies *within* a single sprint: attempt A under prompt v1, attempt B under prompt v2 (if a hot-reload occurred), with no record.

## Steps to reproduce

```bash
# Count reproductionCommand entries per sprint
grep -c '"reproductionCommand"' /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-*-evidence-A.json
# Expect: sprint-1: 0, sprint-2..6: 17-26 each

# Confirm no evaluator-prompt digest field anywhere
grep -l 'evaluatorPromptDigest\|promptHash\|promptVersion' /Users/taa/.gan-runs-data/*/runs/*/sprint-*.json 2>/dev/null
# Expect: (nothing)
```

## Root cause (if known)

`evaluator-evidence-bundle-v1.json` does not declare an `evaluatorPromptDigest` field. The evaluator agent prompt has no instruction to compute or emit one. The orchestrator does not stamp it on the writer side.

## Suggested fix

1. Additive change to `evaluator-evidence-bundle-v1.json` (per the additive-stays-`vN` ruling — no version bump): add optional `evaluatorPromptDigest: { type: "string", description: "SHA-256 of the evaluator-prompt file content at evaluation time" }`.
2. SKILL.md: at evaluator spawn, the orchestrator computes `sha256(agents/gan-evaluator.md)` and stamps the digest on the resulting evidence file.
3. `gan run summary` surfaces a warning when a single run mixes more than one digest.
4. Analogous fields for `independent-review-v1` (`reviewerPromptDigest`) and the contract-reviewer's review output (`contractReviewerPromptDigest`).

This is the cheapest possible audit trail for prompt-protocol drift across sprints, attempts, and runs.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-008-verification.md](BR-008-verification.md) (sonnet)

Reproduction matches: sprint-1 evidence has zero `reproductionCommand` entries (old free-form shape), sprints 2–6 carry 17–26 each (T1 structured shape), and no `evaluatorPromptDigest`/`promptHash`/`promptVersion` field exists in any artefact, schema, or agent prompt. Refinements:

- **The shape change happened between sprint 1 and sprint 2** — not sprint 5 as the report says. Core symptom (mixed shapes in one run) is real either way.
- **`additionalProperties: false` at root and `evidence` levels** means an orchestrator change to start stamping a digest today would be rejected by any schema-validating consumer. Coordinated schema + orchestrator + agent change required.
- **Naming inconsistency surfaces here too.** SKILL.md and the schema description call the artefact `sprint-N-feedback-A.json`; disk emits `-evidence-A.json` (see BR-004). Resolve filename canonicalisation alongside the digest stamping work.

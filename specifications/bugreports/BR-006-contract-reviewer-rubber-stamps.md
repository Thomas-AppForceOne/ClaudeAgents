# BR-006 — Contract-reviewer rubber-stamps drafts without producing change requests

**Status:** Closed — fix shipped by Q9 (contract-reviewer cold-read framing + first-pass script-name resolution + verdict-shape pin). See specifications/Q9-contract-reviewer-cold-read.md and the Q9 roadmap entry.
**Severity:** High
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0` (E8 — 5 of 6 sprints "approved" with empty `issues[]`; draft and locked contracts byte-identical)
- General pattern across newer runs — needs cross-run verification
**Filed:** 2026-06-08

## Description

The `gan-contract-reviewer` agent exists to audit each draft contract for specificity / comprehensiveness / scope / (post-E8) well-foundedness, and to reject ill-formed criteria. In the E8 run that introduced this very role's adversarial framing:

- 5 of 6 sprint contract reviews returned `verdict: "approved"` with `issues: []`.
- The 6th surfaced a single advisory item explicitly graded as "no revision required."
- For all 6 sprints, `sprint-N-contract-draft.json` and `sprint-N-contract.json` have identical byte counts — meaning the contract-reviewer never asked for a single change across the entire run.

This is the same anchoring pathology E8 was written to address at the evaluator boundary, repeating at the contract-reviewer boundary. The contract-reviewer reads the proposer's narrative as input and assents.

Specific examples missed in the E8 sprint 1 contract that the contract-reviewer should have caught:
- Criterion `independent_review_prompt_house_rules_parity` referenced `npm run -s test-house-rules` (no such script exists; real name is `npm run house-rules`).
- Criterion `independent_review_prompt_no_spec_ref` referenced `npm run -s test-no-spec-ref` (real name is `npm run lint-no-spec-ref`).
- Both passed evaluator scoring with note "intent satisfied" (see BR-008 — proposer-side name-resolution pre-flight).

The contract-reviewer's "well-foundedness" rewrite in E8 sprint 4 (post-evidence for inspection findings) is well-intentioned, but the well-formedness audit (does the criterion reference real files / scripts / symbols?) appears to have weakened simultaneously.

## Steps to reproduce

```bash
# Confirm 5/6 contract reviews returned empty issues
for f in /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-*-review.json; do
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
issues = d.get('issues', [])
print(f'{sys.argv[1]}: verdict={d.get(\"verdict\", d.get(\"decision\", \"-\"))} issues={len(issues)}')
" "$f"
done
# Expect: 5 with issues=0, 1 with issues=1 (sprint 1, advisory only)

# Confirm draft and locked contracts are byte-identical
for n in 1 2 3 4 5 6; do
  a=$(wc -c < /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-$n-contract-draft.json)
  b=$(wc -c < /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-$n-contract.json)
  echo "sprint $n: draft=$a locked=$b same=$([ "$a" = "$b" ] && echo YES || echo NO)"
done
```

## Root cause (if known)

The contract-reviewer prompt likely shares the proposer's narrative context (it reads the draft contract verbatim, which itself contains the proposer's rationale strings). It does not have a fresh-context "skeptical senior PM cold-reading the contract" framing analogous to what E8 gave the code-reviewer. It also has no automated pre-checks (e.g. "does every cited npm script in `criteria[].description` resolve at the base commit?") to anchor its judgment.

## Suggested fix

1. Apply the E8 independent-reviewer pattern to the contract-reviewer: fresh context, no anchor on the proposer's rationale strings, well-formedness verifiable structurally (script resolution, file existence at base commit) — see BR-008.
2. Add a CI signal: track contract-reviewer first-round-approval rate per run and warn when it exceeds 90% across a sliding window — same gate-rubber-stamping detection that BR-007's `gan health` provides for evaluators.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-006-verification.md](BR-006-verification.md) (opus)

Reproduction matches verbatim — 5/6 reviews empty `issues[]`, the 6th carries one advisory "no revision required" item, all draft/locked contract pairs byte-identical. Refinements:

- **Verdict shape varies within the same run.** Sprint 1 emits `decision: "approve"`; sprints 2–6 emit `verdict: "approved"`. Downstream consumers that hard-code one key would mishandle this.
- **Only the E8 self-build run was checked.** The "general pattern across newer runs" claim from the report remains unverified cross-run.
- **BR-006 and BR-007 attribute the same observed defect to two different roles** — proposer for emitting fabricated `npm run test-*` names (BR-007), contract-reviewer for not catching them (BR-006). Both attributions hold; either fix layer is plausible, and ideally the two coordinate.
- The contract-reviewer prompt has zero hits for `cold/skeptic/fresh` framing and no instruction to resolve cited script names. Well-foundedness audit only activates on renegotiation rounds with finding-derived criteria — not on first-pass drafts.

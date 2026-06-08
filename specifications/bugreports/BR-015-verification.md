# BR-015 — Verification

**Verifier model:** sonnet
**Verdict:** not-reproducible
**Verified at:** 2026-06-08T18:00:00Z

## Summary

The described symptom — doc-surface criteria multiplying per touched file — does not appear in the cited artifacts. Sprint 4 has exactly 4 doc-surface criteria (not 8 as claimed), and sprint 6 has exactly 4 (matching the claim, but without the duplication framing being meaningful). Every sprint in the run shows exactly one criterion per documentation surface, not per file.

## Reproduction evidence

**Step 1 — Sprint 4 count:**

```
python3 -c "
import json
c = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-4-contract.json'))
docs = [x['name'] for x in c['criteria'] if any(t in x['name'] for t in ['public_contract_completeness','comments_explain_why','nonobvious_decision','comments_cite_no_development_provenance'])]
print(f'sprint 4: {len(c[\"criteria\"])} total, {len(docs)} doc-surface variants:')
for d in docs: print(' -', d)
"
```

Exit code: 0

Actual output:
```
sprint 4: 26 total, 4 doc-surface variants:
 - public_contract_completeness
 - comments_explain_why_not_what
 - nonobvious_decision_cites_rationale
 - comments_cite_no_development_provenance
```

Expected per report: `26 total, 8 doc-surface variants` (with `proposer_prompt_*` and `contract_reviewer_prompt_*` prefixed variants of each surface). **Mismatch: 4 actual vs 8 expected.**

**Step 2 — Sprint 6 count:**

```
python3 -c "
import json
c = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-6-contract.json'))
docs = [x['name'] for x in c['criteria'] if any(t in x['name'] for t in ['public_contract_completeness','comments_explain_why','nonobvious_decision','comments_cite_no_development_provenance'])]
print(f'sprint 6: {len(c[\"criteria\"])} total, {len(docs)} doc-surface variants:')
for d in docs: print(' -', d)
"
```

Exit code: 0

Actual output:
```
sprint 6: 20 total, 4 doc-surface variants:
 - web_node_public_contract_completeness
 - web_node_comments_explain_why_not_what
 - web_node_nonobvious_decision_cites_rationale
 - web_node_comments_cite_no_development_provenance
```

Expected per report: `20 total, 4 doc-surface variants`. **Count matches**, but "duplicated through `web_node_*` prefix variants" is a characterization issue — these are not duplicates of unprefixed variants; they are the only doc-surface criteria for this sprint.

**Broader scan — all sprints in the cited run:**

```
sprint 1: 15 criteria, 4 doc-surface
sprint 2: 17 criteria, 4 doc-surface
sprint 3: 17 criteria, 4 doc-surface
sprint 4: 26 criteria, 4 doc-surface
sprint 5: 21 criteria, 4 doc-surface
sprint 6: 20 criteria, 4 doc-surface
```

No sprint has more than 4 doc-surface criteria. A full scan across all three project roots in `/Users/taa/.gan-runs-data/` found zero contract files with more than 4 doc-surface criteria in any sprint.

## Root-cause assessment

The claimed root cause — "the proposer's template-instantiation logic instantiates per (surface × touched-file)" — is not consistent with the artifact evidence or the proposer specification.

**Against the code (`/Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/gan-contract-proposer.md`, lines 55–64):** The template-instantiation protocol fires once per (stack × surface), not per (stack × surface × file). Step 4 of the protocol says "instantiate the surface's template string as a contract criterion" (singular) — file paths go into the `rationale` field, not into additional criterion instances. The proposer spec explicitly states "Variables (file paths, keyword hits) are recorded as rationale alongside the criterion, not substituted into it."

**Against the artifacts:** Sprint 4 touched two prompt files (`agents/gan-contract-proposer.md` context indicates two agent prompts were rewritten). The four doc-surface criteria do not multiply; each covers both touched files through its evidence commands (verified in `sprint-4-evidence-A.json`, where each criterion's `reproductionCommand` references multiple test files). Sprint 6's `web_node_public_contract_completeness` criterion's `description` field explicitly enumerates all four touched TS test files in a single criterion — exactly what the bug report's suggested fix proposes.

The `web_node_` prefix in sprint 6 is the stack-name prefix mandated by the cross-stack id namespace rule (proposer spec line 51: "Key each instantiated criterion by `<stack-name>.<surface-id>`"). Its absence in sprints 1–5 is the actual anomaly, not the presence in sprint 6.

The evidence of "near-verbatim prose across variants" also does not appear: each doc-surface criterion in both sprints carries distinct evidence commands targeting different semantic checks.

## Concerns / caveats

1. **Naming inconsistency is a real, separate issue.** Sprints 1–5 emit bare names (`public_contract_completeness`) while sprint 6 emits stack-qualified names (`web_node_public_contract_completeness`). The proposer spec mandates the qualified form everywhere; the bare-name form in sprints 1–5 is the deviation. A fix-planner working on this report should note this distinct anomaly.

2. **The `web-node` stack in the snapshot carries no `documentationSurfaces` array** (verified in `snapshot.json`). The proposer is emitting doc-surface criteria that have no declared source in any active stack. This is the real structural gap; the proposer is generating these criteria from internalized knowledge rather than from stack declarations. That means the template-instantiation protocol described in the spec is not actually the mechanism being used, and the bug report's framing of the root cause is doubly incorrect.

3. **The bug report may have been written against an earlier version of the artifacts.** The cited run (`20260530T231724-5cc0`) is the only run under `ClaudeAgents-dea5f7879cf0/`, and its current data does not match the described symptom. No historical version of these JSON files is recoverable from git (they are run artifacts, not source files).

4. **The costs enumerated in the bug report (inflated contract length, extra LLM calls, verbatim evidence) are not present** in the observed artifacts, because the multiplication does not occur.

## Confidence

High — the reproduction steps produce deterministic output from static JSON files, counts are unambiguous, and the proposer specification text directly contradicts the claimed root cause mechanism.

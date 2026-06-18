# BR-015 — Documentation-surface criteria duplicate per touched file in sprint contracts

**Status:** Closed — not-reproducible (per [FIX-ORDER-PLAN.md](FIX-ORDER-PLAN.md) Phase 0, 2026-06-08). Two real anomalies surfaced during verification should be filed as new BRs — see footer.
**Severity:** Low
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-4-contract.json` (26 criteria, of which 8 are the four web-node `documentationSurfaces` × two prompts)
- `sprint-6-contract.json` (20 criteria, of which 4 are doc-surfaces duplicated through `web_node_*` prefix variants)
**Filed:** 2026-06-08

## Description

The contract-proposer template-instantiates the four `documentationSurfaces` (`public_contract_completeness`, `comments_explain_why_not_what`, `nonobvious_decision_cites_rationale`, `comments_cite_no_development_provenance`) once per touched stack-scope file. When a sprint touches multiple files in stack scope, the criteria multiply.

In E8 sprint 4 (which rewrote two agent prompts), the four doc-surfaces appeared as 8 criteria (`proposer_prompt_*` and `contract_reviewer_prompt_*` variants). In sprint 6 (which touched several new TS test files), the same four appeared as 4 criteria prefixed `web_node_*`. The evaluator scored each independently with near-verbatim evidence.

Costs:
- The proposer authors longer contracts than necessary, increasing contract-reviewer audit time.
- The evaluator pays per-criterion LLM cost on what is effectively the same check repeated.
- Evidence files duplicate verbatim prose across the variants, making aggregation noisier.
- Contract length is a load-bearing metric for sprint-budget calibration; inflating it skews the calibration.

Not a correctness bug. A clarity / efficiency bug that compounds with sprint size.

## Steps to reproduce

```bash
# Count doc-surface criteria in sprint 4
python3 -c "
import json
c = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-4-contract.json'))
docs = [x['name'] for x in c['criteria'] if any(t in x['name'] for t in ['public_contract_completeness','comments_explain_why','nonobvious_decision','comments_cite_no_development_provenance'])]
print(f'sprint 4: {len(c[\"criteria\"])} total, {len(docs)} doc-surface variants:')
for d in docs: print(' -', d)
"
# Expect: 26 total, 8 doc-surface variants

python3 -c "
import json
c = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-6-contract.json'))
docs = [x['name'] for x in c['criteria'] if any(t in x['name'] for t in ['public_contract_completeness','comments_explain_why','nonobvious_decision','comments_cite_no_development_provenance'])]
print(f'sprint 6: {len(c[\"criteria\"])} total, {len(docs)} doc-surface variants:')
for d in docs: print(' -', d)
"
```

## Root cause (if known)

The proposer's template-instantiation logic appears to instantiate per (surface × touched-file) rather than per (surface, with `affectedFiles` as the parameter). Each instance gets a unique criterion name (necessary, to satisfy the `criteria[].name` uniqueness constraint), but the underlying check is one check.

## Suggested fix

Adjust the proposer prompt: each `documentationSurface` produces *one* criterion whose `description` enumerates the touched files (`"Every exported function in {file1, file2, ...} carries doc comments per the public-contract template"`). The evaluator then verifies the single criterion against each named file and aggregates the evidence under one verdict.

Optionally: a contract-reviewer audit step that flags multi-file template duplication as ill-formed when the proposer instantiates the same surface against >1 file in one sprint.

---

## Verification update (2026-06-08)

**Verdict:** NOT-REPRODUCIBLE
**Confidence:** high
**Verification report:** [BR-015-verification.md](BR-015-verification.md) (sonnet)

The described per-file multiplication does not occur in the cited artefacts:

- **Sprint 4 has 4 doc-surface criteria, not 8.** Sprint 6 has 4. Every sprint shows one criterion per documentation surface, not per file. The proposer spec (`gan-contract-proposer.md:55–64`) explicitly defines a per-surface instantiation; file paths go into `rationale`, not into additional criterion instances.
- **The costs enumerated in the report** (inflated contract length, extra LLM calls, verbatim evidence) are not present because the multiplication does not occur.

**However, two real, distinct anomalies were surfaced during verification** that the bug report did not file. These should be split off as their own bug reports:

- **Naming inconsistency.** Sprints 1–5 use bare names (`public_contract_completeness`); sprint 6 uses the spec-mandated stack-qualified form (`web_node_public_contract_completeness`). The bare-name form is the deviation.
- **`web-node` carries no `documentationSurfaces` array in the snapshot.** The proposer is generating these criteria from internalised knowledge rather than from stack declarations as the spec's template-instantiation protocol intends — meaning the protocol described in the spec is not the mechanism actually being used.

**Recommended disposition:** close BR-015 as not-reproducible; file the two anomalies as new bug reports.

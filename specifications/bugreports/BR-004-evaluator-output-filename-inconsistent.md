# BR-004 — Four distinct filenames for the same evaluator-output artifact

**Status:** Needs verification
**Severity:** High
**Found in run(s):**
- `sprint-N-evidence-A.json` — original E8 run (`ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0`)
- `sprint-N-evaluator-evidence-A.json` — M4 run (`claudeagents-5f2b0a723ee9/runs/20260531T163227-e220`)
- `sprint-N-evaluation.json` — O1 run (`claudeagents-5f2b0a723ee9/runs/20260601T194010-c238`)
- `sprint-N-feedback-A.json` — multiple newer runs (O2, roadmap-next-task, D1, workshop-site)
**Filed:** 2026-06-08

## Description

The evaluator writes a per-sprint per-attempt artifact containing scores, verdicts, evidence, and feedback. Across 8 runs, four distinct filenames have been observed for this same logical artifact. Downstream consumers (`gan run summary`, recovery, any analysis tool) must guess which to read, or read all four.

The drift appears to be chronological — newer runs increasingly use `sprint-N-feedback-{letter}.json`, which is also the shape implied by the latest evidence files (they include a `feedbackToGenerator` field). But the spec text in E8 and the original implementation use different terms.

Coexistence is the problem, not the naming preference. A run that mixes naming (e.g. recovers an older run with a new orchestrator) would end up with both files present and ambiguous semantics.

## Steps to reproduce

```bash
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d)
  for f in "$d"sprint-1-*.json; do
    [ -f "$f" ] && case "$(basename $f)" in
      sprint-1-evidence-*) echo "$name: evidence-A naming";;
      sprint-1-evaluator-evidence-*) echo "$name: evaluator-evidence-A naming";;
      sprint-1-evaluation.json) echo "$name: evaluation naming";;
      sprint-1-feedback-*) echo "$name: feedback-A naming";;
    esac
  done
done | sort -u
```

## Root cause (if known)

SKILL.md and/or the evaluator agent prompt has been edited across multiple shipped specs without retiring the prior filename convention. There is no central "artifact-naming registry" — each agent writes whatever its prompt says, and prompts diverge over time.

## Suggested fix

1. Author one canonical convention (recommend `sprint-N-feedback-{A,B,C,...}.json` since it is the newest and matches the artifact's `feedbackToGenerator` payload).
2. Update SKILL.md and the evaluator prompt accordingly.
3. Lint the run-dir at terminal: reject any non-canonical filename matching the alternative patterns above (or alias them with a deprecation warning in `progress.json.harnessConditions[]`).
4. Add a CI fixture suite under `tests/fixtures/run-state-shapes/` that pins the convention against future drift.

---

## Verification update (2026-06-08)

**Verdict:** partially-valid
**Confidence:** high
**Verification report:** [BR-004-verification.md](BR-004-verification.md) (sonnet)

All four filename variants and the coexistence case reproduce exactly. The **root cause as filed is wrong**:

- **The prompt has consistently said `sprint-{N}-feedback-{attempt-letter}.json` since the R7 commit `fba3552`** — which predates all four divergent filenames in the artefacts. The drift is LLM runtime deviation from a stable prompt, not spec drift.
- **The O1 coexistence case isn't just a naming variant — it's a *schema* variant.** `evaluation.json` carries a legacy `passes/criterionVerdicts/score/threshold` shape; `feedback-A.json` carries the canonical `evaluator-evidence-bundle-v1.json` shape.
- **The "roadmap-next-task" run cited in the report does not exist** in the on-disk data. Other newer runs do.
- **The real enforcement gap is in H1 confinement.** Check whether the PreToolUse write-allow pattern is permissive enough to admit `-evidence-A.json` and other variants; the canonical pattern in `H1-framework-owned-confinement-hook.md:53` is `sprint-N-feedback-A.json` only.
- **SKILL.md describes the artefact as `sprint-N-feedback-A.json`** but disk emits `-evidence-A.json` (see also BR-008). Decide which is canonical and align all three layers (prompt, SKILL.md, H1 hook) before fixing.

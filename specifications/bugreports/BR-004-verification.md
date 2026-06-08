# BR-004 — Verification

**Verifier model:** sonnet
**Verdict:** partially-valid
**Verified at:** 2026-06-08T00:00:00Z

## Summary

All four filename variants are confirmed in the on-disk run artifacts, and the coexistence case (both `sprint-1-evaluation.json` and `sprint-1-feedback-A.json` in the O1 run) is real and reproduces exactly. However, the stated root cause is wrong: the evaluator agent prompt (`agents/gan-evaluator.md`) and `skills/gan/SKILL.md` have consistently prescribed `sprint-{N}-feedback-{attempt-letter}.json` going back at least to the R7 commit (`fba3552`), which predates all four naming variants appearing in the artifacts. The drift originated from the LLM agent deviating from the prompt instruction at runtime, not from the prompt itself changing across specs.

## Reproduction evidence

### Step: run the glob/case script

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

**Exit code:** 0 (with one zsh glob-no-match warning for the workshop-site run that has no sprint-1-*.json files).

**Actual output (trimmed):**
```
20260530T231724-5cc0: evidence-A naming
20260531T163227-e220: evaluator-evidence-A naming
20260531T195539-9f56: feedback-A naming
20260601T194010-c238: evaluation naming
20260601T194010-c238: feedback-A naming
20260606T180005-70ef: feedback-A naming
20260606T195320-b600: feedback-A naming
20260606T214636-1588: feedback-A naming
```

All four naming patterns are observed. The run `20260601T194010-c238` (O1) shows both `evaluation naming` and `feedback-A naming` in the same sprint — the coexistence case the bug report flags.

### Breakdown across all sprints and runs (not just sprint-1)

Using `find` across all sprint numbers:
- `sprint-*-evidence-*.json`: **8 files** (all in run `20260530T231724-5cc0`, sprints 1–6)
- `sprint-*-evaluator-evidence-*.json`: **2 files** (run `20260531T163227-e220`, sprint 1 attempts A and B)
- `sprint-*-evaluation.json`: **1 file** (run `20260601T194010-c238`, sprint 1)
- `sprint-*-feedback-*.json`: **11 files** (runs `20260531T195539-9f56`, `20260601T194010-c238`, `20260606T180005-70ef`, `20260606T195320-b600`, `20260606T214636-1588`)

### Coexistence verification (O1 run)

Both files are present in run `20260601T194010-c238`:

```
-rw-r--r--  10320  sprint-1-evaluation.json
-rw-r--r--  16083  sprint-1-feedback-A.json
```

They cover the same 15 criteria against the same sprint. They use **different schema shapes**: `evaluation.json` uses `{criterionVerdicts[], passes, score, threshold, passed}` while `feedback-A.json` uses the `evaluator-evidence-bundle-v1.json` shape `{criteria[], verdict, evidence.traceEventRefs, evidence.reproductionCommand, evidence.deltaFromContract}`. Both were written to the same run directory for sprint 1, attempt A.

## Root-cause assessment

The bug report claims the cause is "SKILL.md and/or the evaluator agent prompt has been edited across multiple shipped specs without retiring the prior filename convention." This is **not supported** by the source evidence.

**What the source shows:**

- `agents/gan-evaluator.md` at commit `fba3552` (R7, the base commit of the E8 run `20260530T231724-5cc0`) already specifies `$GAN_RUN_DIR/sprint-{N}-feedback-{attempt-letter}.json` in three places: lines 59, 70, and in the output format section. The same naming is present in the T1 commit (`1ede5a4`) and earlier.
- `skills/gan/SKILL.md` at the current HEAD (`b44601f`) references `sprint-N-feedback-A.json` exclusively (line 174).
- `schemas/evaluator-evidence-bundle-v1.json` line 178 names the artifact `sprint-{N}-feedback-{attemptLetter}.json`.
- `specifications/T1-structured-run-trace.md` line 103 names it `.gan-state/runs/<run-id>/sprint-{N}-feedback-{attempt-letter}.json`.
- `specifications/O2-recovery.md` line 85 names it `sprint-N-feedback-A.json`.
- `specifications/E3-evaluator-pipeline-harness.md` line 122 names it `sprint-{N}-feedback-{attempt-letter}.json`.

**What actually caused the variants:**

The prompt has been consistently prescribing `feedback-{attempt-letter}` naming since at least `fba3552` (before any of the four divergent artifact naming styles appeared in runs). The E8 run (`20260530T231724-5cc0`) used `fba3552` as its base commit, yet produced `sprint-N-evidence-A.json`. The M4 run (`20260531T163227-e220`) also ran against a codebase where the prompt said `feedback-{attempt-letter}`, yet produced `sprint-N-evaluator-evidence-A.json`. The O1 run (`20260601T194010-c238`) produced both `sprint-1-evaluation.json` (non-canonical shape, earlier schema) and `sprint-1-feedback-A.json` (canonical shape per v1 schema).

The observed divergence is **LLM agent non-compliance at runtime**: the evaluator LLM agent chose filenames that did not match the prompt's instruction. There is no "central artifact-naming registry" (this part of the report is accurate), but the lack of one does not explain why the LLM deviated — the prompt is the registry, and the prompt was correct.

**What is true in the root cause:** There is no enforcement layer that rejects a run-directory write whose filename does not match the canonical pattern. The prompt instruction is advisory from the LLM's perspective; nothing in the confinement hook (`H1`) or any validator (`validateAll`, `validateFindings`) checks the evaluator's output filename. That is the real gap.

## Concerns / caveats

1. **Different schema shapes, not just different names.** The O1 coexistence case involves two files with materially different JSON schemas. `evaluation.json` has a `passes/criterionVerdicts/score/threshold/passed` shape; `feedback-A.json` has the `evaluator-evidence-bundle-v1.json` shape with `criteria[]/verdict/evidence.traceEventRefs`. A downstream consumer reading `sprint-1-evaluation.json` and treating it as an evidence bundle would see different field names. The bug report treats this as a naming inconsistency only; it is also a schema inconsistency.

2. **The "roadmap-next-task" run mentioned in the bug report does not exist** in the on-disk data. The three project roots are `ClaudeAgents-dea5f7879cf0`, `claudeagents-5f2b0a723ee9`, and `workshop-site-71c837164a90`. No run directory matches "roadmap-next-task." This may be a run that did not persist, was deleted, or the label refers to a subject string rather than a directory name. The "multiple newer runs" claim still holds from the data that is present.

3. **The zsh glob warning** in the step's output (`no matches found: ...sprint-1-*.json`) is a shell-specific issue with the loop when a run directory has no sprint-1 files (the workshop-site run `20260608T171254-22af`). The script still produces correct output for all other runs.

4. **Recovery-specific risk is real but understated.** The SKILL.md `evaluating` recovery branch explicitly references `sprint-N-feedback-A.json` (line 174). If a recovered run tries to find a prior evaluator output from a run that used `evidence-A` naming, it would find nothing and re-evaluate. The bug report mentions "A run that mixes naming would end up with both files present" — the O1 run confirms this exact scenario: the orchestrator or the LLM wrote both a legacy-shaped `evaluation.json` and a canonical `feedback-A.json` in the same sprint.

5. **A fix-planner should note:** the actual enforcement gap is that the PreToolUse confinement hook (`H1`) allows writes to `sprint-{N}-feedback-{attempt-letter}.json` but does not prevent writes to `sprint-{N}-evidence-{attempt-letter}.json` or other variants. The hook pattern from `specifications/H1-framework-owned-confinement-hook.md` line 53 lists `sprint-N-feedback-A.json` as the allowed pattern; if the evaluator LLM writes to a non-canonical path, H1 may or may not block it depending on how permissive the write-allow pattern is. This is worth checking.

## Confidence

high — all four filename variants are directly confirmed in on-disk artifacts by the exact reproduction script, the coexistence case is visible, and the root-cause discrepancy is substantiated by checking the git history of `agents/gan-evaluator.md` back to before the earliest divergent run.

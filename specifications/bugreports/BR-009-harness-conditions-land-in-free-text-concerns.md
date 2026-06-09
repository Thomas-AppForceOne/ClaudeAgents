# BR-009 — Evaluator harness-condition observations land in free-text `concerns` field; signal does not aggregate

**Status:** Needs verification
**Severity:** Medium
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-evidence-A.json` (criterion `existing_tests_still_pass`, free-text `concerns` field)
**Filed:** 2026-06-08

## Description

The evaluator sometimes observes a real, actionable condition about the run *environment* (as distinct from the code being judged) — a missing `node_modules` in the worktree, vitest version drift, a host-resolver flake, an environmental test failure. There is no typed channel for these observations.

Observed in E8 sprint 1 evaluation:

```json
"concerns": [
  "The worktree was missing its own node_modules at evaluation start, causing the orchestrator's earlier `npm test` to silently use the wrong vitest version. Not a defect introduced by the sprint, but a run-harness condition worth flagging — if the orchestrator expects the generator to verify tests before declaring done, the harness should also ensure `npm install` ran in the worktree first."
}
```

This is exactly the kind of signal that should aggregate across runs ("3 of last 10 runs hit `worktree-missing-deps`") and trigger fixes. Buried in a free-text string on one criterion, it dies on aggregation. It also makes the evaluator look noisy when it surfaces such an observation, biasing future runs against surfacing them.

The pattern recurs in the workshop-site run, where the evaluator-side captured a great deal of environmental shell output but had nowhere structured to log it — so it created `evaluator-logs/` ad-hoc (see BR-012).

## Steps to reproduce

```bash
# Confirm the concerns field exists with prose
python3 -c "
import json
d = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-evidence-A.json'))
for c in d.get('criteria', []):
    if c.get('concerns'):
        print(c['name'])
        for x in c['concerns']:
            print(' -', x[:120])
"

# Confirm no typed harness-conditions channel exists anywhere
grep -rln 'harnessCondition\|harnessConditions' /Users/taa/.gan-runs-data/ 2>/dev/null
# Expect: (nothing)
```

## Root cause (if known)

`evaluator-evidence-bundle-v1.json` has a per-criterion `concerns: string[]` field but no top-level typed channel for environmental observations. The evaluator prompt does not distinguish "concern about the code I'm evaluating" from "concern about the environment I'm evaluating in."

## Suggested fix

Additive to `evaluator-evidence-bundle-v1.json`: top-level `harnessConditions: array of {condition: string, severity: 'blocker' | 'warning' | 'advisory', observedDuring: 'build' | 'test' | 'lint' | 'audit' | 'doc-lint' | 'other', remediation: string}`.

Evaluator prompt: an environmental observation (missing dep, version drift, host-resolver flake, hung command, sandbox restriction) goes in `harnessConditions[]` with a stable `condition` identifier, never as prose under a criterion's `concerns`. The per-criterion `concerns[]` stays for code-relevant doubts.

`gan health` aggregates `harnessConditions[].condition` counts across runs.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-009-verification.md](BR-009-verification.md) (sonnet)

The environmental harness observation is present verbatim in the cited artefact's per-criterion `concerns` field; no top-level `harnessConditions` channel exists in the schema or in any artefact across all three project roots. Refinements:

- **The `criterion` definition does *not* set `additionalProperties: false`** (unlike the top-level object, `evidence`, `deltaFromContract`, and `verdictSummary` — all of which do). The ad-hoc `concerns` field is silently accepted. A fix-planner must decide: tighten criterion-level strict additional-properties, formally promote `concerns`, or remove the field.
- **`sprint-1-evidence-A.json` also has undocumented top-level fields `overall` and `summary`** — suggests an older/deviant evaluator prompt version was in use for that run.
- **Single occurrence across all runs is misleading.** Workshop-site runs expressed the same class of environmental observation through `evaluator-logs/` directories instead (see BR-012). Both are symptoms of the same missing typed channel — fix together.
- **Aggregation impact is latent.** No `gan health` command currently consumes `harnessConditions` counts; impact materialises only when such a command is built.

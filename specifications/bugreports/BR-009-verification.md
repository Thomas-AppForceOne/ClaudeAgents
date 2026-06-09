# BR-009 — Verification

**Verifier model:** sonnet
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

The environmental harness observation reported in BR-009 is present verbatim in the cited artifact under the per-criterion `concerns` field; no top-level `harnessConditions` channel exists in the schema or in any run artifact across all three project roots. Both reproduction steps pass exactly as described.

## Reproduction evidence

**Step 1 — Confirm the concerns field exists with prose**

```
$ python3 -c "
import json
d = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-evidence-A.json'))
for c in d.get('criteria', []):
    if c.get('concerns'):
        print(c['name'])
        for x in c['concerns']:
            print(' -', x[:120])
"
```

Exit code: 0

Output:
```
existing_tests_still_pass
 - The worktree was missing its own node_modules at evaluation start, causing the orchestrator's earlier `npm test` to sile
```

The full text matches the report's quoted string exactly.

**Step 2 — Confirm no typed harness-conditions channel exists**

```
$ grep -rln 'harnessCondition\|harnessConditions' /Users/taa/.gan-runs-data/ 2>/dev/null
```

Exit code: 0 (no matches)

Output: (empty — no files returned)

A broader search of the codebase confirms the same: the only occurrences of `harnessConditions` in `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/` are in BR-009 itself and in BR-004, both of which merely reference the feature as absent.

## Root-cause assessment

The root cause claim holds up exactly.

1. **Schema confirms no `harnessConditions` field** — `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/evaluator-evidence-bundle-v1.json` defines three top-level required properties (`sprintNumber`, `attemptLetter`, `criteria`, `verdictSummary`) and no optional `harnessConditions` array anywhere. The `criterion` definition (lines 76–101) lists `evidence`, `name`, and `verdict` — there is no `concerns` field defined either; the criterion definition omits `additionalProperties: false`, so `concerns` was accepted at runtime without schema error but is entirely unvalidated and undocumented.

2. **Evaluator prompt has no guidance for environmental observations** — `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/gan-evaluator.md` defines the per-criterion fields in a table (lines 179–188) and the top-level bundle shape (lines 149–177). Neither the table nor the example JSON shows a `concerns` field or any environmental-observation channel. The prompt says nothing about distinguishing code-quality concerns from harness/environment concerns, leaving the evaluator to improvise — which is precisely what produced the free-text entry in `concerns`.

3. **Single occurrence across all run artifacts** — A scan of all 19 evidence/feedback files across all three project roots (`ClaudeAgents-dea5f7879cf0`, `claudeagents-5f2b0a723ee9`, `workshop-site-71c837164a90`) found `concerns` populated in exactly one file: the cited `sprint-1-evidence-A.json`. Other runs absorbed environmental observations differently (e.g., `workshop-site-71c837164a90` produced ad-hoc `evaluator-logs/` directories, consistent with the BR-012 cross-reference). The one-of-19 occurrence rate understates the problem: it reflects inconsistency of expression, not absence of the underlying environmental condition.

4. **`concerns` is an undocumented ad-hoc extension** — The artifact also carries undocumented top-level fields `overall` and `summary` not present in the schema (`additionalProperties: false` at top level would reject them). The schema does not validate against the live artifacts, so the `concerns` field went in without any enforcement barrier.

## Concerns / caveats

- The `criterion` definition in the schema does NOT set `additionalProperties: false` (unlike the top-level object, the `evidence` definition, `deltaFromContract`, and `verdictSummary`, all of which do). This means additional per-criterion fields like `concerns` are silently accepted by any schema-aware validator. A fix-planner needs to decide whether the criterion definition should also enforce strict additional-properties or whether `concerns` should be formally promoted (as a deprecated migration path) or simply removed.
- The `sprint-1-evidence-A.json` file also has undocumented top-level fields `overall` and `summary`, suggesting this run used an older or deviant evaluator prompt version. A fix-planner should verify whether the `gan-evaluator.md` prompt version in use at that run is the same as the current one.
- The single occurrence of `concerns` across all runs may give a misleading impression of rarity. The workshop-site runs expressed the same class of environmental observation through `evaluator-logs/` instead (BR-012). Both are symptoms of the same missing typed channel.
- The aggregation failure is real but currently unobservable: there is no `gan health` command that would consume `harnessConditions` counts. The impact is latent until such a command is built.

## Confidence

high — both reproduction steps executed cleanly with exact expected outputs, the schema file was read directly, and the evaluator prompt was confirmed to have no guidance on environmental observations.

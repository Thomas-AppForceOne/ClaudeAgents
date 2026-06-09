# BR-014 — Verification

**Verifier model:** sonnet
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

The `web-node` stack manifest does declare `lintCmd: "vitest run"` — the test runner — in both the ClaudeAgents and ClaudeAgents-verify repos. At least one evaluator evidence file (run `20260531T163227-e220`) explicitly labels this execution as "(the lintCmd)" while noting it "replays the same 25 failures" as `npm test`, confirming the duplication and conflation described in the report.

## Reproduction evidence

**Step 1 — snapshot.json check (exit 0):**

```
python3 -c "
import json
s = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/snapshot.json'))
stack = s['activeStacks'][0]
print('name:', stack['name'])
print('lintCmd:', stack['lintCmd'])
print('testCmd:', stack['testCmd'])
"
```
Output:
```
name: web-node
lintCmd: vitest run
testCmd: npm test
```

**Step 2 — stack file grep (exit 0):**

```
grep -E '^lintCmd|^testCmd' /Users/taa/AppForceOne/projects/ClaudeAgents/stacks/web-node.md
```
Output:
```
testCmd: npm test
lintCmd: vitest run
```

Both commands reproduce exactly as the bug report predicts.

**Additional artifact evidence:**

In evaluator evidence file `/Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T163227-e220/sprint-1-evaluator-evidence-A.json`, the evaluator explicitly executed both `npm test` (as `testCmd`) and `vitest run` (as `lintCmd`) in a single verification command string:

```
"verificationCommandRun": "npm test && npx vitest run && npm run build && npm run doc-lint"
```

The evidence text reads: "`npm run build` exits 0; `npm run doc-lint` exits 0; `vitest run` (the lintCmd) replays the same 25 failures."

This directly confirms the described consequence: the evaluator ran the full test suite twice and reported test failures as lint failures.

The evaluator plan for that same run also carries:

```json
"buildTestLint": {"buildCmd": "npm run build", "testCmd": "npm test", "lintCmd": "vitest run"}
```

## Root-cause assessment

The root-cause hypothesis — that `lintCmd: "vitest run"` was set expediently early and never updated — is consistent with the git history. The field was introduced in commit `d7604a3` ("Configuration-API redesign: Phase 0-3 + post-E1 revision break", merged 2026-05-03) and has not been changed in any subsequent commit (`1167ebb`, `4ce29b2`). There is no separate lint script in the stack file; the actual linting (eslint, house-rules, lint-no-stack-leak, etc.) lives in project-specific `package.json` scripts that the stack manifest does not reference.

The `stack-v1.json` schema defines `lintCmd` as `{"type": "string"}` — a plain string with no constraint preventing it from equaling `testCmd` or naming a test-runner binary. No schema validation or runtime check catches this misconfiguration.

The `package.json` of the ClaudeAgents-verify project confirms the equivalence: `"test": "vitest run"`, so `npm test` and `vitest run` are identical invocations. The bug report's claim that `lintCmd` duplicates `testCmd` in practical effect is accurate.

The report's note that "the project's actual lint coverage lives in stack-orthogonal scripts cited individually per-criterion" is also consistent with the codebase: `package.json` carries separate scripts (`lint`, `lint-no-spec-ref`, `lint-no-stack-leak`, `lint-error-text`, `house-rules`, `doc-lint`) none of which are referenced by the stack manifest's `lintCmd`.

Files and lines confirmed:
- `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/stacks/web-node.md`, line 35: `lintCmd: vitest run`
- `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/stack-v1.json`: `lintCmd` schema is `{"type": "string"}` with no additional constraints
- `/Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T163227-e220/sprint-1-evaluator-evidence-A.json`: explicit evidence of duplication in a live run

## Concerns / caveats

1. **Scope of artifact evidence is limited.** Only one run (`20260531T163227-e220`) yielded evaluator evidence with explicit `lintCmd` execution visible in the evidence text. The E8 run (`20260530T231724-5cc0`) has a snapshot confirming the field value but no evaluator evidence file that mentions `lintCmd` by name (it uses an older file format: `sprint-N-evidence-A.json` not `sprint-N-evaluator-evidence-A.json`). The claim "every web-node run" is supported by all snapshots checked having the same value, but direct evidence of duplication harm is confirmed in one run.

2. **The `lintCmd` / `testCmd` equivalence is project-specific.** On a user project where `npm test` is configured differently (e.g., running Jest rather than Vitest), `vitest run` as `lintCmd` would not merely duplicate but would fail outright if vitest is not installed. The bug is therefore worse on generic user projects than on this framework repo.

3. **The W1 deferred item is relevant but does not resolve this.** The W1 spec explicitly deferred a per-stack command-override warning (not directly applicable here), and the bug report's suggestion to add a sanity check for `lintCmd === testCmd` or test-runner binaries is not yet specified or implemented anywhere.

4. **`absenceSignal` is not available for plain `lintCmd`.** The schema shows `auditCmd` and `docLintCmd` support `absenceSignal: warning`, but `lintCmd` is a bare string. The "honest" fix (option 2 in the report) of declaring `lintCmd` absent cannot use the same absenceSignal mechanism without a schema change.

## Confidence

high — both reproduction steps execute exactly as described, the stack file and snapshot confirm the field value, and one live evaluator evidence artifact explicitly demonstrates the duplicate-execution consequence with unambiguous language.

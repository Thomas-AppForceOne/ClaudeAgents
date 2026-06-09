# BR-014 — `web-node` stack declares `lintCmd: "vitest run"` — the test runner, not a linter

**Status:** Needs verification
**Severity:** Low
**Found in run(s):** Every web-node run (all 7 ClaudeAgents internal runs + the E8 run examined)
**Filed:** 2026-06-08

## Description

The `web-node` builtin stack manifest declares:

```
lintCmd: "vitest run"
```

`vitest run` is the test runner, not a linter. When the E8 evaluator's "forced bash execution" path runs `lintCmd`, it runs the full test suite a second time (after `testCmd: "npm test"` already ran it once). The actual lint coverage in this project lives in stack-orthogonal scripts (`lint-no-spec-ref`, `lint-no-stack-leak`, `lint-error-text`, `house-rules`, `doc-lint`) that contracts cite individually per-criterion.

Consequences:
- Every web-node project (this repo + any future user project on the same stack) inherits the same misconfiguration.
- The evaluator's `lintCmd` path executes redundant work (duplicates `npm test`) and reports test failures as lint failures, conflating two classes of signal.
- Cross-stack analysis that compares `lintCmd` cost across stacks gets a wrong baseline for web-node.

## Steps to reproduce

```bash
# Confirm the snapshot
python3 -c "
import json
s = json.load(open('/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/snapshot.json'))
stack = s['activeStacks'][0]
print('name:', stack['name'])
print('lintCmd:', stack['lintCmd'])
print('testCmd:', stack['testCmd'])
"
# Expect: lintCmd: vitest run / testCmd: npm test

# Confirm the stack file itself
grep -E '^lintCmd|^testCmd' /Users/taa/AppForceOne/projects/ClaudeAgents/stacks/web-node.md
```

## Root cause (if known)

The `web-node.md` stack file likely had `lintCmd` filled in expediently with `vitest run` early on (when there was no separate lint script) and was never updated when project-specific lint scripts landed.

## Suggested fix

Two options:
1. **Strict**: set `lintCmd` to a real linter (`eslint . --ext .ts,.tsx`) and depend on the project's existing eslint setup.
2. **Honest**: declare `lintCmd` absent (signal `absent` per the stack manifest's `absenceSignal: warning` convention) so the evaluator surfaces "no lint command for web-node — run project-specific lint scripts via additional criteria." This is closer to what is actually true: web-node ships no canonical lint command, and projects layer their own.

Either is an improvement; option 2 is more honest and propagates correctly to other web-node projects (which may not have eslint configured the same way).

Add a stack-default sanity check (extension of W1's overlay-misuse warnings): warn when `lintCmd === testCmd` or when `lintCmd` resolves to a test-runner binary.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-014-verification.md](BR-014-verification.md) (sonnet)

`stacks/web-node.md:35` declares `lintCmd: vitest run`; the schema places no constraint preventing `lintCmd` from equalling `testCmd`. Refinements:

- **Direct evidence of the duplication harm is in one run** (`20260531T163227-e220`). Its evaluator evidence labels the execution `"(the lintCmd)"` and says it "replays the same 25 failures" as `npm test`. The E8 run uses the older `sprint-N-evidence-A.json` format which doesn't mention `lintCmd` by name.
- **On generic user projects, the impact is worse.** Where `npm test` is *not* Vitest (Jest, Mocha, plain `node --test`, …), `vitest run` as `lintCmd` would fail outright rather than merely duplicate work.
- **`lintCmd` does not support `absenceSignal: warning`** (unlike `auditCmd` and `docLintCmd`). The report's "option 2 — declare lintCmd absent" requires a schema change.
- **The W1 deferred per-stack command-override warning** does not cover this case.

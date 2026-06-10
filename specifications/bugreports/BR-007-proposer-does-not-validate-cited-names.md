# BR-007 — Proposer does not validate that scripts / files / symbols named in criteria actually resolve

**Status:** Closed — fix shipped by Q8 (proposer pre-flight name-resolution validator: validateCriterionReferences MCP tool + agent-prompt wiring). See specifications/Q8-proposer-name-resolution.md and the Q8 roadmap entry.
**Severity:** High
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-contract.json` (criteria reference `npm run -s test-house-rules` and `npm run -s test-no-spec-ref`, neither of which exists)
**Filed:** 2026-06-08

## Description

The contract-proposer authors criteria that name concrete scripts, files, symbols, and commands. The evaluator later attempts to verify by running them. When the proposer names something that does not exist, the evaluator is forced to either (a) grade pass-on-intent (BR observed) or (b) fail the criterion for a reason orthogonal to the actual deliverable.

Observed in the E8 sprint 1 contract:

- Criterion `independent_review_prompt_house_rules_parity`: description says *"Running `npm run -s test-house-rules` from the worktree exits 0..."*. No `test-house-rules` script exists in `package.json`. The real script is `npm run house-rules`.
- Criterion `independent_review_prompt_no_spec_ref`: description says *"Running `npm run -s test-no-spec-ref` from the worktree exits 0..."*. Real script is `npm run lint-no-spec-ref`.
- Both criteria were scored 9/10 by the evaluator with notes like *"the criterion's `test-house-rules` script alias is a naming slip; intent satisfied."*

Under the recalibrated post-E8 rubric (`pass requires score >= threshold AND no unresolved blocker`), "intent satisfied" is borderline as a pass justification for a script-name mismatch. It also blunts the deterministic-verification thesis: the *point* of forced bash execution is that the named command runs; if the named command does not exist, the criterion has not been verified, it has been reasoned about.

This is the contract-author equivalent of a typo. A pre-flight check would catch it cheaply.

## Steps to reproduce

```bash
# Confirm the criteria cite nonexistent scripts
grep -E '"test-house-rules"|"test-no-spec-ref"' /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-contract.json

# Confirm the scripts do not exist in package.json at the run's base commit
git -C /Users/taa/AppForceOne/projects/ClaudeAgents show fba3552834a66fabf51ba1f98be72ff1bd10d15f:package.json | python3 -c "
import json, sys
pkg = json.load(sys.stdin)
scripts = pkg.get('scripts', {})
print('test-house-rules:', scripts.get('test-house-rules', 'NOT FOUND'))
print('test-no-spec-ref:', scripts.get('test-no-spec-ref', 'NOT FOUND'))
print('house-rules:', scripts.get('house-rules', 'NOT FOUND'))
print('lint-no-spec-ref:', scripts.get('lint-no-spec-ref', 'NOT FOUND'))
"
```

## Root cause (if known)

The contract-proposer authors `description` strings as free prose; the contract-reviewer audits well-formedness in prose; nothing structurally checks that quoted shell commands, file paths, and exported-symbol names resolve at the run's base commit. The proposer has no "list the npm scripts; only cite scripts in that list" instrumentation.

## Suggested fix

Add a proposer-side pre-flight tool (new MCP tool, e.g. `validateCriterionReferences(contract, baseRef)`):
- Parses every `criteria[].description` for backtick-quoted shell tokens (`npm run X`, paths like `agents/Y.md`, symbols like `validateFindings`).
- For each, checks resolution at the run's base commit (the script appears in `package.json`'s scripts; the path exists; the symbol is exported).
- Returns structured `{name, kind, resolved, hint}` records.
- The proposer is required to consume the tool's output and either fix unresolved names or strip them from the criterion description before locking.
- The contract-reviewer's well-formedness audit verifies the tool was consulted (by checking a trace event) and rejects the draft if any unresolved reference survived.

Cheap pre-flight, prevents this whole class of error.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-007-verification.md](BR-007-verification.md) (opus)

The cited npm scripts (`test-house-rules`, `test-no-spec-ref`) are absent from the base-commit `package.json`, the evaluator graded both on "intent satisfied", and an exhaustive search of agents/MCP tools/schemas confirms no proposer-side pre-flight resolves cited names. Refinements:

- **The literal `grep -E '"test-house-rules"|"test-no-spec-ref"'` recipe in Steps to reproduce does not match** because the names are embedded inside backtick-quoted shell tokens within a longer `description` string, not as JSON keys with surrounding double quotes. Remove the quotes from the regex.
- **The evaluator's "intent satisfied" behaviour is partly licensed by its own prompt**, not just an unconstrained heuristic. A proposer-only fix may not close the loop; coordinated tightening of evaluator latitude may also be needed.
- **The fix's scope of "names" is unstated.** Three reference kinds (npm scripts, file paths, exported symbols) have very different cost/precision profiles. A v1 pre-flight likely covers only the cheapest (npm scripts).
- **Only one run / one sprint examined.** The defect class is plausible cross-run but not measured here.
- **Cross-references BR-006.** Same observed defect, two pipeline roles.

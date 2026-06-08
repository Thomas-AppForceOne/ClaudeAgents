# BR-007 — Verification

**Verifier model:** opus
**Verdict:** confirmed
**Verified at:** 2026-06-08T18:04:45Z

## Summary

The sprint-1 contract for run `20260530T231724-5cc0` cites two npm scripts (`test-house-rules`, `test-no-spec-ref`) that do not exist in `package.json` at the run's base commit, the evaluator graded both on "intent satisfied", and an exhaustive search of agents, MCP tools, and schemas confirms no proposer-side pre-flight resolves cited names. The root cause hypothesis stands.

## Reproduction evidence

### Step 1 — Contract cites the nonexistent script names

Command:
```
grep -E '"test-house-rules"|"test-no-spec-ref"' /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-1-contract.json
```

The original regex returns no rows because the contract embeds these names inside backtick-quoted shell tokens (`` `npm run -s test-house-rules` ``) inside a longer description string, not as JSON keys. A relaxed grep (`-E 'test-house-rules|test-no-spec-ref'`) matches two `description` fields:

- `independent_review_prompt_house_rules_parity`: *"Running `npm run -s test-house-rules` from the worktree exits 0 and reports the new file as a participant."*
- `independent_review_prompt_no_spec_ref`: *"Running `npm run -s test-no-spec-ref` from the worktree exits 0; agents/gan-reviewer-independent.md contains no internal-spec references..."*

Symptom is real — the brittleness of the report's grep regex is itself a small caveat (see Concerns).

### Step 2 — Scripts are absent in `package.json` at the base commit

Base commit (per `sprint-1-base-commit.txt`): `fba3552834a66fabf51ba1f98be72ff1bd10d15f`.

Command and output:
```
git -C /Users/taa/AppForceOne/projects/ClaudeAgents show fba3552834a66fabf51ba1f98be72ff1bd10d15f:package.json | python3 -c "..."

test-house-rules: NOT FOUND
test-no-spec-ref: NOT FOUND
house-rules: node dist/scripts/house-rules/index.js
lint-no-spec-ref: node dist/scripts/lint-no-spec-ref/index.js
```

Confirms the cited script names do not resolve; the real scripts are `house-rules` and `lint-no-spec-ref`.

### Step 3 — Evaluator graded both 9/10 on intent

From `sprint-1-evidence-A.json`:

- `independent_review_prompt_house_rules_parity` — score 9, verdict pass: *"...The criterion's reference to `npm run -s test-house-rules` is a script-name slip (no such script exists; the real script is `npm run house-rules`); scoring on intent per instructions..."*
- `independent_review_prompt_no_spec_ref` — score 9, verdict pass: *"...Criterion's `test-no-spec-ref` script alias is a naming slip (real script is `lint-no-spec-ref`); intent satisfied."*

Both criteria were passed via a substituted script after the evaluator silently re-mapped the typo — exactly the BR's described pattern.

## Root-cause assessment

The hypothesis ("contract-proposer authors `description` as free prose; nothing structurally checks that quoted shell commands, file paths, or symbol names resolve at the run's base commit") holds up under code inspection:

- **Agent prompts.** `agents/gan-contract-proposer.md` describes criterion construction but never requires resolving cited shell commands, paths, or symbols. The only "exists" check in its prompt is `referenceArtifacts[].path` (lines 171-194), which is a one-line discipline aimed at the optional reference-artifacts array — not the free-prose `description`. `agents/gan-contract-reviewer.md` audits criteria for specificity, comprehensiveness, scope, threshold-shape, and well-foundedness of finding-derived criteria (lines 40-58), but performs no script/path/symbol resolution against the base commit. Neither prompt asks the proposer to enumerate `package.json`'s scripts before citing one.
- **MCP tools.** A repo-wide `grep -l "validateCriterionReferences\|validateReferences\|criterionReferences\|backtick.*npm\|listScripts\|preflight"` over `src/config-server/tools/*.ts` returns zero hits. The eleven existing tools (`docker-tools.ts`, `evaluator-tools.ts`, `independent-review.ts`, `reads.ts`, `run-context.ts`, `run-lock.ts`, `safety.ts`, `telemetry.ts`, `trace.ts`, `validate.ts`, `writes.ts`) cover config/recovery/run-state but none parses criterion text or resolves cited names.
- **Schemas.** `schemas/*.json` contains no sprint-contract schema at all (closest siblings: `independent-review-v1`, `overlay-v1`, `progress-v1`, `evaluator-evidence-bundle-v1`). The contract is freeform JSON the proposer authors directly; there is no schema-enforced shape for criterion `description`, let alone a reference-resolution constraint.
- **Hooks / "preflight".** The only "preflight" surfaces in the codebase are unrelated: D1's `ConfigApiUnreachable` orchestrator preflight (`specifications/D1-diagnostic-clarity.md`, `skills/gan/SKILL.md` § "ConfigApiUnreachable preflight") and O2's recovery preflight / deferred terminal-status preflight (`specifications/O2-recovery.md` lines 249-466; `tests/skills/skill-recover-resume-dispatch.test.ts` lines 135-146). Neither inspects contract criterion text.

Conclusion: no pre-flight validation tool exists anywhere in the proposer pipeline (MCP tools, agent prompts, schemas, hooks). The root-cause claim is consistent with the codebase.

## Concerns / caveats

- **The BR's exact reproduction command does not match the on-disk contract.** The provided regex (`grep -E '"test-house-rules"|"test-no-spec-ref"'`) returns no rows because the script names are embedded inside backtick-quoted shell tokens within a longer `description` string, not as JSON keys/values with surrounding double quotes. The regex needs the quotes removed (or alternative anchors). The underlying symptom is unaffected; this is a small reproducibility-recipe defect, not a substantive issue with the report.
- **Evaluator instructions are part of the picture.** The evaluator notes say "scoring on intent per instructions". A fix-planner should know that the evaluator's "intent satisfied" behaviour is at least partly licensed by its own prompt, not just an unconstrained heuristic — a real fix may need to coordinate the proposer pre-flight with a tightening of evaluator latitude so a name-mismatch is not silently re-mapped downstream. The BR notes this in passing ("blunts the deterministic-verification thesis") but a planner should not assume a proposer-only fix closes the loop.
- **Scope of "names" is unstated.** The BR's suggested fix lists three reference kinds (npm scripts, file paths, exported symbols). Each has a different cost/precision profile (npm scripts: cheap, exact; paths: cheap if base-ref is available; symbols: requires a parser per language). A planner should expect to triage which kinds the v1 pre-flight actually covers.
- **Only one run / one sprint examined.** Verification is on a single run's sprint-1 contract. The class of defect is plausible across other runs but not measured here.

## Confidence

high — the script names are absent in the base commit's `package.json`, the evaluator's own evidence text admits the slip and shows the "intent satisfied" graded pass, and exhaustive search of agents / MCP tools / schemas confirms no proposer-side pre-flight resolves cited names.

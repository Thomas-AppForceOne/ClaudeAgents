# BR-006 — Verification

**Verifier model:** opus
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

Both reproduction commands return the exact pattern the bug report describes — 5/6 sprint contract reviews carry empty `issues[]`, the 6th carries one advisory item explicitly graded "no revision required", and every draft/locked contract pair is byte-identical. The cited example criteria genuinely reference non-existent npm scripts (`test-house-rules`, `test-no-spec-ref`) that the contract-reviewer let through, and the contract-reviewer's own SKILL prompt has no fresh-context / script-resolution framing comparable to what the independent reviewer received in E8.

## Reproduction evidence

### Step 1 — sprint review verdicts and issue counts

Command:

```bash
for f in /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-*-review.json; do
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
issues = d.get('issues', [])
print(f'{sys.argv[1]}: verdict={d.get(\"verdict\", d.get(\"decision\", \"-\"))} issues={len(issues)}')
" "$f"
done
```

Exit code: 0. Actual output:

```
sprint-1-review.json: verdict=approve   issues=1
sprint-2-review.json: verdict=approved  issues=0
sprint-3-review.json: verdict=approved  issues=0
sprint-4-review.json: verdict=approved  issues=0
sprint-5-review.json: verdict=approved  issues=0
sprint-6-review.json: verdict=approved  issues=0
```

Sprint 1's single issue is severity `advisory` with note ending "but no revision required" — matching the bug report's claim that the lone surfaced item was explicitly graded as non-blocking.

### Step 2 — draft vs locked contract byte counts

Command:

```bash
for n in 1 2 3 4 5 6; do
  a=$(wc -c < .../sprint-$n-contract-draft.json)
  b=$(wc -c < .../sprint-$n-contract.json)
  echo "sprint $n: draft=$a locked=$b same=$([ "$a" = "$b" ] && echo YES || echo NO)"
done
```

Exit code: 0. Actual output:

```
sprint 1: draft=11013 locked=11013 same=YES
sprint 2: draft=17313 locked=17313 same=YES
sprint 3: draft=11291 locked=11291 same=YES
sprint 4: draft=17387 locked=17387 same=YES
sprint 5: draft=12695 locked=12695 same=YES
sprint 6: draft=12850 locked=12850 same=YES
```

Every sprint locked exactly the draft, byte for byte. No revision rounds happened.

### Step 3 — corroborating the specific cited examples

The bug report claims the sprint-1 contract referenced two scripts that do not exist at the base commit. Inspecting `sprint-1-contract.json`:

- `independent_review_prompt_house_rules_parity` description contains: `Running \`npm run -s test-house-rules\` from the worktree exits 0...`
- `independent_review_prompt_no_spec_ref` description contains: `Running \`npm run -s test-no-spec-ref\` from the worktree exits 0...`

`git show fba35528:package.json` (the sprint-1 base commit) lists these scripts in the matching namespace: `house-rules`, `lint-no-spec-ref`, `lint-no-stack-leak`. There is no `test-house-rules` and no `test-no-spec-ref`. The contract-reviewer did not catch either name mismatch — sprint 1's only flagged item was an unrelated `independent_review_schema_bundled` advisory.

## Root-cause assessment

The cited root cause holds up against the agent prompt at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/gan-contract-reviewer.md`:

- The independent reviewer at `agents/gan-reviewer-independent.md:9` is framed explicitly as "a skeptical senior engineer asked to review a pull request **cold**" with "fresh context plus criterion-free framing" as its load-bearing independence lever. It is deliberately not shown the proposer's draft.
- The contract-reviewer at `gan-contract-reviewer.md:17` takes the proposer's draft as primary input ("the contract draft — the proposer's draft for this sprint"). There is no "cold" / "skeptical" / "fresh-context" framing anywhere in the prompt; a `grep -n -i "cold|skeptic|fresh"` returns zero hits.
- The well-foundedness audit at `gan-contract-reviewer.md:48-60` is gated on "finding-derived criteria" — criteria added from a "surviving-findings payload" with an `evidencePointer` — i.e. it activates only on renegotiation rounds after an independent-reviewer finding. The initial draft on a fresh sprint receives only the well-formedness pass.
- The well-formedness pass at `gan-contract-reviewer.md:40-46` (specificity / comprehensiveness / scope / threshold-shape) makes no mention of resolving cited npm script names, file paths, or symbols against the base commit. There is no instruction analogous to "before approving, verify every cited script / file / function actually exists at HEAD" — which would have caught both `test-house-rules` and `test-no-spec-ref`.

So the bug report's two-part diagnosis is correct on both counts: (a) the contract-reviewer reads the proposer's narrative as input without a fresh-context anchor, and (b) it has no structural pre-flight (script / file existence check) to catch a well-formed-looking criterion whose names are fabricated. The "well-foundedness rewrite in E8 sprint 4" referenced in the bug report does add factual-claim verification, but only on the renegotiation path — the first-pass audit is unchanged.

## Concerns / caveats

- The verdict shape varies: sprint 1 emits `decision: "approve"`, sprints 2–6 emit `verdict: "approved"`. The reproduction script already handles both with `d.get("verdict", d.get("decision", "-"))`; the bug is unaffected, but a downstream consumer that hard-codes one key would mishandle this run. Out of scope for BR-006 but worth flagging to a fix-planner.
- Only one run (the E8 self-build) is checked here. The bug report says "general pattern across newer runs — needs cross-run verification"; that sweep was not part of the reproduction steps, so the cross-run claim remains unverified. The single-run evidence is, however, very clean.
- The bug report dovetails with BR-008 (proposer-side name-resolution pre-flight). A reader should understand that BR-006 and BR-008 attribute the *same observed defect* (fabricated `npm run test-*` names) to two different roles — the proposer for emitting them, the contract-reviewer for not catching them. Both attributions hold; the framework happens to have two layers where the check could land.
- The 6th review's lone advisory is not, strictly speaking, "empty issues[]" — the bug report acknowledges this in the prose ("5 of 6") and the reproduction shows `issues=1` for sprint 1. The advisory's own note ("no revision required") makes the substantive claim — that the reviewer never asked for a change across the entire run — exactly true.

## Confidence

high — both reproduction commands match the report verbatim, the specific cited examples are present in the artefacts, the base-commit `package.json` confirms the cited scripts do not exist, and the contract-reviewer prompt structurally lacks the framing the bug report says it lacks.

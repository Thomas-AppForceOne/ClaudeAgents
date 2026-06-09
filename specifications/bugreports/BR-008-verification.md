# BR-008 — Verification

**Verifier model:** sonnet
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

Both reproduction steps execute exactly as the bug report predicts: sprint-1 evidence carries zero `reproductionCommand` entries (old free-form shape) while sprints 2–6 carry 17–26 each (new T1 shape), and no `evaluatorPromptDigest`, `promptHash`, or `promptVersion` field exists anywhere in the run artifacts or in the current codebase schemas or agent prompts.

## Reproduction evidence

**Step 1 — Count `reproductionCommand` entries per sprint:**

```
$ grep -c '"reproductionCommand"' /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/sprint-*-evidence-A.json

sprint-1-evidence-A.json:0
sprint-2-evidence-A.json:17
sprint-3-evidence-A.json:17
sprint-4-evidence-A.json:26
sprint-5-evidence-A.json:21
sprint-6-evidence-A.json:20
```

Exit code: 0. Matches the expected output precisely (sprint-1: 0; sprints 2–6: 17–26).

The structural difference was further confirmed: sprint-1 has keys `{sprintNumber, attemptLetter, overall, criteria, summary}` with `evidence` as a plain string and per-criterion `score`/`threshold` fields — the old free-form shape. Sprints 2–6 have keys `{sprintNumber, attemptLetter, criteria, verdictSummary}` with `evidence` as an object carrying `{traceEventRefs, reproductionCommand, deltaFromContract}` — the current T1 schema shape.

**Step 2 — Confirm no evaluator-prompt digest field anywhere:**

```
$ grep -l 'evaluatorPromptDigest\|promptHash\|promptVersion' \
    /Users/taa/.gan-runs-data/*/runs/*/sprint-*.json 2>/dev/null
(no output)
Exit code: 1
```

The search returned nothing across all three project roots (`ClaudeAgents-dea5f7879cf0`, `claudeagents-5f2b0a723ee9`, `workshop-site-71c837164a90`) and all their runs. Identical result from a direct per-file Python scan of all six sprint files in the referenced run.

## Root-cause assessment

The three cited root causes all hold:

1. **`evaluator-evidence-bundle-v1.json` has no `evaluatorPromptDigest` field.**
   Confirmed at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/evaluator-evidence-bundle-v1.json`. The schema's `evidence` definition (line 119–143) declares exactly three properties — `deltaFromContract`, `reproductionCommand`, `traceEventRefs` — and sets `additionalProperties: false`, so the field cannot be added to existing evidence objects without a schema change. The top-level bundle object is likewise locked (`additionalProperties: false`, line 4) with properties `{attemptLetter, criteria, sprintNumber, verdictSummary}` only.

2. **The evaluator agent prompt has no instruction to compute or emit a digest.**
   `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/gan-evaluator.md` contains no occurrence of `digest`, `sha256`, `promptVersion`, or `promptHash`.

3. **The orchestrator (SKILL.md) has no instruction to stamp a digest on the evaluator side.**
   `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/skills/gan/SKILL.md` likewise contains no such instruction. The evaluator-spawn section (around line 437: "Evaluator forced-plan derivation") describes what the orchestrator passes to the evaluator but says nothing about computing or attaching a prompt digest.

The `independent-review-v1.json` schema at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/independent-review-v1.json` is also `additionalProperties: false` with no reviewer prompt digest field, consistent with the bug report's note that the analogous gap exists there too.

## Concerns / caveats

- The bug report states the evaluator-prompt rewrite "landed in sprint 5." The artifact evidence shows the shape change occurred between sprint 1 and sprint 2, not sprint 5. Sprint 2 already uses the new T1 shape with `reproductionCommand`. This may mean the rewrite landed before sprint 2 (or was applied retroactively to sprints 2–6 while sprint 1 was left as-is), but the core observable — mixed shapes within a single run — is real regardless of which sprint introduced the change.
- The `additionalProperties: false` constraint at both the root and `evidence` levels means that even if an orchestrator were modified to stamp a digest today, any schema-validating consumer would reject the bundle as non-conforming. A fix requires coordinated schema + orchestrator + agent changes.
- The bug report refers to these files as `sprint-N-evidence-A.json`, but the SKILL.md description (line 174) and schema description call the evaluator's output artefact `sprint-N-feedback-A.json`. The actual artifacts on disk use `-evidence-A.json`. This naming inconsistency is pre-existing and unrelated to the bug but could confuse a fix-planner following SKILL.md.

## Confidence

high — both reproduction commands ran cleanly and produced exactly the predicted output; the schema, agent, and SKILL.md sources all confirm the absence of the digest field at every layer of the stack.

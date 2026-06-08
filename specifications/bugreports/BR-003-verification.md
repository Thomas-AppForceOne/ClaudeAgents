# BR-003 — Verification

**Verifier model:** sonnet
**Verdict:** partially-valid
**Verified at:** 2026-06-08T18:45:00Z

## Summary

The symptom is real: 8 of 8 `progress.json` files have divergent key-sets, and 6 of 8 fail validation against the current `schemas/progress-v1.json`. However, the root cause is wrong: `schemas/progress-v1.json` *does* exist — it was shipped in PR #37 (O2 Recovery, commit `5b4acb6`, 2026-06-01) — so the claim "no published schema" is false. The drift persists in post-O2 runs because the orchestrator's live write path is not yet wired to the validator, not because there is no schema.

## Reproduction evidence

### Step 1 — run the key-set enumeration script

```
python3 << 'EOF'
import os, json
roots = ['/Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs',
         '/Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs',
         '/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs']
for r in roots:
    if not os.path.isdir(r): continue
    for d in sorted(os.listdir(r)):
        path = os.path.join(r, d, 'progress.json')
        if os.path.isfile(path):
            doc = json.load(open(path))
            print(f"{d}: keys = {sorted(doc.keys())}")
EOF
```

Exit code: 0. Output (8 distinct key-sets, none identical):

```
20260531T163227-e220: keys = ['completedAt', 'contractRevision', 'currentSprint', 'finalCommit', 'invocation', 'runId', 'snapshot', 'specPath', 'sprintsCompleted', 'sprintsPassed', 'startedAt', 'status', 'subject', 'terminal', 'terminalReason', 'workspace']
20260531T195539-9f56: keys = ['baseBranch', 'completedSprints', 'contractRevision', 'currentAttempt', 'currentSprint', 'overlaysAtSnapshot', 'projectRoot', 'recoveryHistory', 'runBranch', 'runId', 'startingBranch', 'status', 'terminal', 'terminalAt', 'terminalReason', 'totalSprints', 'workspace']
20260601T194010-c238: keys = ['contractRevision', 'endedAt', 'passes', 'runId', 'schemaVersion', 'spec', 'startedAt', 'status', 'subject', 'terminal', 'terminalReason', 'workspace']
20260606T180005-70ef: keys = ['baseBranch', 'completedSprints', 'contractRevision', 'currentAttempt', 'currentSprint', 'overlaysAtSnapshot', 'projectRoot', 'recoveryHistory', 'runBranch', 'runId', 'startingBranch', 'status', 'terminal', 'terminalAt', 'terminalReason', 'totalSprints', 'workspace']
20260606T214636-1588: keys = ['contractRevision', 'currentAttempt', 'currentSprint', 'runId', 'schemaVersion', 'sprints', 'status', 'terminal', 'terminalReason', 'workspace']
20260606T195320-b600: keys = ['contractRevision', 'currentAttempt', 'currentSprint', 'runId', 'startedAt', 'status', 'terminal', 'terminalReason', 'workspace']
20260608T171254-22af: keys = ['abortReason', 'contractRevision', 'currentAttempt', 'currentSprint', 'runId', 'specSource', 'startedAt', 'status', 'terminal', 'terminalReason', 'workspace']
20260530T231724-5cc0: keys = ['baseBranch', 'baseCommit', 'contractRevision', 'finalCommit', 'finishedAt', 'label', 'projectRoot', 'runBranch', 'runId', 'specPath', 'sprints', 'startedAt', 'status', 'terminal', 'terminalReason', 'totalCommits', 'workspace']
```

All claimed divergences reproduce exactly: 4 distinct end-time field names (`completedAt`, `terminalAt`, `endedAt`, `finishedAt`, plus 3 runs with none); 3 distinct sprint-tracking shapes; 5 distinct subject fields (`subject`, `spec`, `specPath`, `specSource`, `label`, plus runs with none); `snapshot.activeStacks` in exactly 1 run (20260531T163227-e220); `schemaVersion: 1` in exactly 2 runs (20260601T194010-c238, 20260606T214636-1588).

### Step 2 — validate each document against the current schema

An additional validation pass confirms 6 of 8 runs fail `additionalProperties: false`:

```
20260531T163227-e220 (pre-O2):  INVALID: Additional properties not allowed ('completedAt', 'finalCommit', 'invocation', 'snapshot', 'specPath', 'sprintsCompleted', 'sprintsPassed', 'startedAt', 'subject' ...)
20260531T195539-9f56 (pre-O2):  VALID
20260601T194010-c238 (post-O2): INVALID: Additional properties not allowed ('endedAt', 'passes', 'schemaVersion', 'spec', 'startedAt', 'subject' ...)
20260606T180005-70ef (post-O2): VALID
20260606T214636-1588 (post-O2): INVALID: Additional properties not allowed ('schemaVersion', 'sprints' ...)
20260606T195320-b600 (post-O2): INVALID: Additional properties not allowed ('startedAt' ...)
20260608T171254-22af (post-O2): INVALID: Additional properties not allowed ('abortReason', 'specSource', 'startedAt' ...)
20260530T231724-5cc0 (pre-O2):  INVALID: Additional properties not allowed ('baseCommit', 'finalCommit', 'finishedAt', 'label', 'specPath', 'sprints', 'startedAt' ...)
```

Notably, **4 of the 5 post-O2 runs still fail**, confirming the write-boundary is not enforced even after the schema shipped.

## Root-cause assessment

The report states: *"No `schemas/progress-v1.json` exists."* This is **false**.

`schemas/progress-v1.json` was created in PR #37 (commit `5b4acb6`, merged 2026-06-01) as part of the O2 Recovery v1.0 slice. The schema is strict (`additionalProperties: false`), covers 17 required fields, and includes the cross-field `terminal` / `terminalReason` / `terminalAt` invariant via `allOf`.

The schema is also bundled and exported: `src/config-server/schemas-bundled.ts` imports it as `progressV1` (line 21) and exports a compiled `validateProgress` function via `src/config-server/validation/schema-check.ts` (line 166). The validator is wired into `writeProgressFields` and `recordWorkspace` inside the config-server tool layer.

However, the **orchestrator's own write path** — the Claude session that drives a `/gan` run and directly writes `progress.json` to disk — is not enforced by this server-side gate during runs. The 4 post-O2 invalid runs confirm this: runs on 2026-06-01, 2026-06-06, and 2026-06-08 still produced non-conforming documents with fields the schema does not allow (`endedAt`, `sprints`, `startedAt`, `schemaVersion`, `abortReason`, `specSource`). The orchestrator composes `progress.json` from prose descriptions in `SKILL.md` and from prior-run examples, drifting from the schema, and the write-boundary validator is only enforced for calls made through the MCP tool layer (`writeProgressFields`, `relockContract`, `recordWorkspace`, `seedProgress`) — not for direct orchestrator writes.

The second part of the root-cause claim — *"same root cause as BR-002"* (no validator at the write boundary) — **does hold**, but the problem is not the absence of a schema; it is incomplete coverage of the write-boundary enforcement. Some write paths (MCP-tool-mediated) are schema-gated; others (direct orchestrator file writes outside the tool layer) are not.

The report's subsidiary claim — *"SKILL.md describes `progress.json` in prose; each orchestration session's Claude reconstructs the shape from prose"* — is accurate and explains the drift even post-O2.

The claim that `schemaVersion: 1` is *"meaningless when there is no schema to version"* is also wrong; the schema exists. It remains semantically odd (the schema is `progress-v1` regardless of that field), but the field's presence in 2 of 8 runs is simply a non-conforming extra property, not a philosophical incoherence.

## Concerns / caveats

1. **Two runs already validate clean against the current schema** (20260531T195539-9f56, 20260606T180005-70ef). A fix-planner should note that the schema shape is achievable by the orchestrator — these runs prove it — and may want to understand what drove conformance in those two cases but not the others.

2. **`startedAt` is missing from the canonical schema.** Five of 8 runs carry a `startedAt` field, yet it does not appear in `schemas/progress-v1.json`'s `properties` or `required` list. The schema's canonical start-time signal is absent entirely (there is a `terminalAt` for end-time, but no `startedAt` or equivalent). A fix-planner adding missing fields should address this asymmetry.

3. **`sprints[]` detail is absent from the canonical schema.** The report's suggested fix includes `sprints[{sprintNumber, verdict, attempts[...]}]`. The current schema has no `sprints` array at all. Runs `20260606T214636-1588` and `20260530T231724-5cc0` both wrote a `sprints` array (with incompatible shapes); the schema rejects both. Any fix that adds a `sprints` field must resolve the two incompatible sprint shapes before declaring a winner.

4. **`snapshot.activeStacks` and `finalCommit` appear in only 1–2 runs.** If the fix-planner makes these required, older runs and in-flight runs that lack them will permanently fail validation. An optional-but-typed approach may be safer.

5. **Historical runs are permanently non-conforming.** Even a perfect schema fix applied forward cannot backfill old runs. A graceful-read path (the report mentions "graceful migration") will still be needed for `--recover` and any reporting tool to handle the 6 non-conforming runs already on disk.

6. **The O2 PR #37 commit message PR body explicitly lists the shipped pieces** and confirms `seedProgress`, `assertValidProgress`, `writeProgressFields`, and `recordWorkspace` as schema-gated writers — but the orchestrator's own run-loop (the direct JSON writes outside those tool calls) is not listed, confirming the gap identified above.

## Confidence

high — the schema file's existence is directly verifiable from the filesystem and git log, and the validation results from `jsonschema.validate` against the on-disk files are deterministic.

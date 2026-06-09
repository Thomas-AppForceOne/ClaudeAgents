# BR-003 — `progress.json` has no canonical schema; field naming varies wildly across runs

**Status:** Needs verification
**Severity:** Blocker
**Found in run(s):** All 8 runs — every `progress.json` has a different key-set
**Filed:** 2026-06-08

## Description

`progress.json` is the orchestrator's run-state file. It is consumed by `--recover` (O2), revision-scoped budget (E8), and would be consumed by every cross-run analysis tool (`gan run summary`, `gan stats`, `gan health`). It has no published schema.

Across 8 runs, **no two `progress.json` files share the same key-set**. Specific divergences:

- Five distinct field names for "when did the run end": `finishedAt`, `endedAt`, `terminalAt`, `completedAt`, or none.
- Three distinct ways to track sprint progress: `sprints[{attempts:[{criteriaPassed, criteriaTotal}]}]` (original E8); `sprints[{verdict, commitSha, slice}]` (D1, no attempts/criteria detail); `{completedSprints, totalSprints, currentSprint, currentAttempt}` (workshop-site, no sprints array at all).
- Five distinct field names for "what was this run about": `label`, `subject`, `spec`, `specPath`, `specSource`.
- Commit tracking inconsistent: `finalCommit` (E8, M4), per-sprint `commitSha` (D1), or absent (workshop-site).
- `snapshot.activeStacks` recorded in only 1 of 8 runs (M4) — every other run loses which stack was active.
- `schemaVersion: 1` present in 2 of 8 runs (O1, D1) — meaningless when there is no schema to version.

This makes BR-006 (`gan run summary`) and BR-007 (`gan health`) structurally impossible to ship. A run report tool must either fall through 5 different field-name conditionals per field, or accept that 7 of 8 historical runs are unreadable.

## Steps to reproduce

```bash
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
# Expect: 8 distinct key-sets, no two identical
```

## Root cause (if known)

No `schemas/progress-v1.json` exists. SKILL.md describes `progress.json` in prose; each orchestration session's Claude reconstructs the shape from prose plus prior-run examples and drifts. There is no validator at the write boundary (same root cause as BR-002).

## Suggested fix

Author `schemas/progress-v1.json` with required fields covering: `runId`, `status`, `terminal`, `terminalReason`, `startedAt`, `endedAt`, `baseCommit`, `finalCommit`, `subject`, `specPath`, `activeStacks[]`, `contractRevision`, `sprints[{sprintNumber, verdict, attempts[{attemptLetter, verdict, criteriaPassed, criteriaTotal, commitSha}]}]`. Validate at every write. Backfill missing fields on the next write rather than refusing to read older runs (graceful migration).

## Suggested fix — corollary

Once this exists, BR-006 / BR-007 unblock.

---

## Verification update (2026-06-08)

**Verdict:** partially-valid
**Confidence:** high
**Verification report:** [BR-003-verification.md](BR-003-verification.md) (sonnet)

Symptom is real (8 of 8 runs diverge; 6 of 8 fail validation) but the **root cause as filed is wrong**:

- **`schemas/progress-v1.json` *does* exist.** It shipped in PR #37 (O2 Recovery, commit `5b4acb6`, 2026-06-01). The "no published schema" claim is false.
- **The actual gap is incomplete write-boundary coverage.** MCP-tool writes (`seedProgress`, `assertValidProgress`, `writeProgressFields`, `recordWorkspace`) are schema-gated; the orchestrator's *direct* JSON writes bypass them.
- **Schema is also incomplete.** `startedAt` is present in 5 of 8 runs but missing from `properties`. `sprints[]` appears in 2 runs with incompatible shapes; the schema has no `sprints` array at all. `snapshot.activeStacks` and `finalCommit` appear in only 1–2 runs.
- **Two runs (`9f56`, `70ef`) already validate clean** — the shape is achievable as-is.
- **Historical runs are permanently non-conforming.** Any forward fix needs a graceful-read path for `--recover` and reporting tools.

A fix should target the orchestrator-direct write path (not "add a schema") and complete the schema with the missing fields above.

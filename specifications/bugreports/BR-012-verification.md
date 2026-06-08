# BR-012 — Verification

**Verifier model:** sonnet
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

Both `evaluator-logs/` (12 files, 2.4 MB) and `evaluator-logs-B/` (2 files) directories exist in the cited run and are absent from every documented spec, schema, agent prompt, and skill file. The T1 spec's `trace/payloads/` channel covers LLM prompt/response blobs only — there is no documented channel for captured shell command output or browser logs — confirming that the evaluator invented its own sidecar directories.

## Reproduction evidence

**Step 1 — Confirm directory structure:**

```
$ ls -lh /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs/
# exit code: 0
total 4848
-rw-r--r--@ 1 taa  staff   2.3K Jun  6 23:13 c1-c5-head-after-restore.log
-rw-r--r--@ 1 taa  staff   2.3K Jun  7 10:41 c1-c5-head-attempt-b.log
-rw-r--r--@ 1 taa  staff   2.3K Jun  6 23:00 c1-c5-head.log
-rw-r--r--@ 1 taa  staff    32K Jun  7 10:45 c6-baseline-attempt-b.log
-rw-r--r--@ 1 taa  staff    28K Jun  6 23:02 c6-baseline.log
-rw-r--r--@ 1 taa  staff   2.3K Jun  7 10:46 c6-head-restore-attempt-b.log
-rw-r--r--@ 1 taa  staff   979K Jun  7 10:55 c7-base-attempt-b.json
-rw-r--r--@ 1 taa  staff     0B Jun  7 10:47 c7-base-attempt-b.stderr
-rw-r--r--@ 1 taa  staff   379K Jun  6 23:11 c7-chromium.log
-rw-r--r--@ 1 taa  staff   979K Jun  7 11:05 c7-head-attempt-b.json
-rw-r--r--@ 1 taa  staff     0B Jun  7 10:56 c7-head-attempt-b.stderr
-rw-r--r--@ 1 taa  staff    53B Jun  7 10:41 seed-attempt-b.log

$ ls -lh /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs-B/
# exit code: 0
total 8
-rw-r--r--@ 1 taa  staff     0B Jun  6 23:43 01-head-clearcache.log
-rw-r--r--@ 1 taa  staff   2.3K Jun  6 23:44 02-head-mobile.log
```

Files, sizes, and naming conventions match the bug report exactly (12 files / 2.4 MB in `evaluator-logs/`, 2 files in `evaluator-logs-B/`).

**Step 2 — Confirm no trace/ or telemetry/ entry in this run:**

```
$ ls -la /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/ | grep -E 'trace|telemetry'
# exit code: 1 (no output)
```

The run directory contains only: `affected-files.json`, `clarified-spec.md`, `evaluator-logs/`, `evaluator-logs-B/`, `plan.md`, `progress.json`, `raw-prompt.md`, `spec.md`, `sprint-1-base-commit.txt`, several `sprint-1-contract*` and `sprint-1-feedback*` JSON files. No `trace/` or `telemetry/` entry exists.

For comparison, other project roots (`claudeagents-5f2b0a723ee9`, `ClaudeAgents-dea5f7879cf0`) have proper `trace/` directories in their runs, and none of those runs contain any `evaluator-logs*` directory.

**Step 3 — Confirm no documentation mentions evaluator-logs:**

```
$ grep -rln 'evaluator-logs' \
    /Users/taa/AppForceOne/projects/ClaudeAgents-verify/specifications/ \
    /Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/ \
    /Users/taa/AppForceOne/projects/ClaudeAgents-verify/skills/ 2>/dev/null
# exit code: 0
# Output: only the bug report files themselves and BR-001/BR-009 cross-references
```

The term `evaluator-logs` appears only in bug report files — not in any spec, agent prompt, or skill file. The search over `agents/` and `skills/` returned exit code 0 with no matching files at all.

## Root-cause assessment

The root cause hypothesis is well-supported:

**T1's payload channel covers only LLM call content.** T1-structured-run-trace.md (lines 50–51, 168–172) defines `trace/payloads/` exclusively for LLM prompt and response blobs referenced by `llmCall` events. The seven T1 event classes (`orchestratorMilestone`, `agentAttempt`, `llmCall`, `toolCall`, `safetyHalt`, `trustEvent`, `validationAbort`) include no event class for captured shell command output, browser logs, or Playwright JSON traces. There is no `capturedCommandOutput` event class and no `*Ref` hashed-payload-file pattern for evaluator command captures anywhere in T1 or any other spec.

**O2 recovery is unaware of evaluator-logs.** O2-recovery.md (lines 79–90) enumerates the canonical run directory tree: `progress.json`, `raw-prompt.md`, `clarified-spec.md`, `sprint-N-contract*.json`, `sprint-N-feedback-*.json`, `sprint-N-objection-*.json`, `sprint-N-base-commit.txt`, `worktree/`, `trace/`, and `telemetry/`. No `evaluator-logs/` or `evaluator-logs-B/` appear. Any `--recover` operation reading this run would silently skip the 2.4 MB of sidecar data.

**The correlation with BR-001 is plausible but independent.** The absence of `trace/` in this run (confirmed above) is the BR-001 symptom; `evaluator-logs/` could be a fallback that arose because the evaluator had no sanctioned channel to write its captured output. However, the `evaluator-logs/` directories would be undocumented even in runs that do have `trace/` directories, because T1 simply never specifies a channel for this kind of data. The BR-012 defect exists independently of BR-001.

## Concerns / caveats

1. **Only one project root is affected.** The `evaluator-logs*` directories appear exclusively under `workshop-site-71c837164a90`. The other two project roots in `.gan-runs-data/` (`claudeagents-5f2b0a723ee9`, `ClaudeAgents-dea5f7879cf0`) have no such directories. This may mean the workshop-site evaluator prompt had custom output-capturing logic not present in the standard evaluator — the codebase's `agents/` directory was checked and contains no reference to `evaluator-logs`, so the writing agent may be a one-off or a locally modified prompt variant.

2. **Inconsistent naming already observed.** Within the single run, the naming is already inconsistent: `evaluator-logs/` uses criterion-based prefixes (`c1-c5`, `c6`, `c7`) while `evaluator-logs-B/` uses numeric prefixes (`01`, `02`). This confirms the bug report's claim that "tomorrow's run might use different scheme."

3. **c7-base-attempt-b.stderr is 0 bytes.** The `.stderr` sidecar exists but is empty, while the `.json` sidecar is 979 KB. This is exactly the asymmetric pattern the bug report flags as unpredictable.

4. **A fix-planner should check the evaluator agent prompt for the code path that writes these directories**, since neither `agents/gan-evaluator.md` nor any skill file mentions `evaluator-logs`. The writing logic may live in an ad-hoc section of the evaluator's instructions or in inline tool calls the agent made during the run — neither is recoverable from the spec layer alone.

## Confidence

high — all three reproduction commands ran against the live artifact and codebase, the directory contents match the report exactly, the absence from O2's run-tree schema and T1's event taxonomy is verified against the shipped spec files, and no `evaluator-logs` string appears in agents or skills.

# BR-001 — Verification

**Verifier model:** opus
**Verdict:** confirmed
**Verified at:** 2026-06-08T17:58:59Z

## Summary

All three observed failure shapes reproduce exactly against the cited run artefacts, and the root-cause hypothesis is consistent with the shipped code, SKILL.md prose, and the R7 spec's own self-described limitation. The bug report's only inaccuracy is a misnamed test file (`run-context.test.ts` vs. the actual `trace.test.ts`), which does not affect the verdict.

## Reproduction evidence

### Step 1 — D1 run trace event listing

Command:
```
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260606T214636-1588/trace/events/
```
Exit code: 0. Output (verbatim):
```
0000000000.json
0000000001.json
0000000002.json
0000000003.json
0000000004.json
0000000005.json
0000000006.json
```
Matches expected (7 files, gapless 0..6).

### Step 2 — D1 run event-type histogram

Command:
```
for f in /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260606T214636-1588/trace/events/*.json; do
  python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['eventType'])" "$f"
done | sort | uniq -c
```
Exit code: 0. Output (verbatim):
```
   7 orchestratorMilestone
```
Matches expected. Zero `agentAttempt`, zero `llmCall`, despite 4 sprints with full role artefacts on disk (`sprint-{1..4}-{contract,contract-review,feedback-A,generator-result,independent-review-A}.json` all present; `progress.json.sprints[]` records all 4 as `verdict: "passed"` with commit SHAs). The trace milestones themselves are coarse: `clarification-start`, sprint-passed transitions, and `all-sprints-passed` (sample event payloads confirm this).

### Step 3 — O1 run empty trace/

Command:
```
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260601T194010-c238/trace/
```
Exit code: 0. Empty output. `ls -la` confirms `trace/` exists (created 2026-06-01 21:41) and contains only `.` and `..`. The same directory has a sibling `telemetry/` that is likewise empty. The run otherwise produced `clarified-spec.md`, `spec.md`, `progress.json`, a complete sprint-1 contract bundle, and a `sprint-1-evaluation.json` — so the orchestrator did real work yet emitted nothing into `trace/` or `telemetry/`.

### Step 4 — workshop-site run missing trace dir

Command:
```
ls -la /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/ | grep -E 'trace|telemetry'
```
Exit code: 0 from the pipeline, but `grep` produced no matching lines. A follow-up `ls .../trace` returned `No such file or directory` (exit 1). The run directory does contain `evaluator-logs/` and `evaluator-logs-B/` directories (ad-hoc captures), consistent with the report's reference to BR-012.

## Root-cause assessment

The cited root cause holds up.

1. **R7 makes emission a tool, not a structural side-effect.** The MCP wrapper and the shared library both live at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/src/trace/emit.ts` (the soft-failure policy) and `src/trace/append.ts` (the raw write). The wrapper's contract is documented (`emit.ts` lines 1-57): it returns a structured warning on drop and never throws. There is nothing that *guarantees* the orchestrator calls it.

2. **SKILL.md instructs but does not enforce.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/skills/gan/SKILL.md` line 421 names the four event types (`orchestratorMilestone`, `agentAttempt`, `llmCall`, `toolCall`) the orchestrator is supposed to emit via `emitTraceEvent({ runDir, event })`. Recovery (line 433), loop detection (line 435), and the clarifier (line 417) all *read* `agentAttempt` events. Nowhere in SKILL.md is there a terminal-time check that any `agentAttempt` event landed for an executed role.

3. **R7 self-documents this as a known gap.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/specifications/R7-runtime-invocation-bridge.md` line 110: *"R7 proves the tool works and is called at the documented SKILL.md points, not that Claude obeys every emit instruction at runtime. The end-to-end 'a real orchestrated run actually emits a trace' assertion needs an LLM and is therefore dogfood/manual-only (tracked as a program risk in the roadmap, not a CI gate)."*

4. **Roadmap explicitly flags the downstream-compounding hazard.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/specifications/roadmap.md` line 113 names this as the "downstream correctness compounds on trace-emission fidelity" risk, and says O2 recovery counters, E8 revision-scoped budget, and O3 cost rollup all silently degrade when emission is skipped — precisely the failure mode the bug report observes.

5. **No `traceEmissionGap` invariant exists.** A grep across `specifications/`, `skills/`, and `src/` for `traceEmissionGap`, "emission.*invariant", and "post-attempt.*invariant" finds no hits outside the bug report itself.

## Concerns / caveats

- **Test-file path is wrong in the bug report.** The report cites `tests/config-server/tools/run-context.test.ts` as the location of the R7 unit tests. That file exists but tests `resolveRunStore` and `createRunWorkspace`, not `emitTraceEvent`. The actual `emitTraceEvent` tests are at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/tests/config-server/tools/trace.test.ts` (e.g. lines 116-167, 418, 458, 539). The substantive claim — "the R7 tool exists and works" — is correct; the path is a minor citation slip.

- **D1 telemetry directory is *missing* (not empty).** The bug report describes the O1 case as `trace/` and `telemetry/` "exist but are empty", which holds. For the D1 run, only `trace/` exists; there is no `telemetry/` directory. That is consistent with D1 starting before O3 (which introduced telemetry) — the report does not call out a D1 telemetry directory and is not wrong, but a fix-planner should note D1 pre-dates O3 and won't show the O3 outcome.json gap.

- **The 7 D1 milestone events fire from clarification + sprint-pass transitions.** They are not entirely empty: payloads include a `clarification-start` event with the prompt and a final `all-sprints-passed` with commit SHAs. So the milestone slot of `emitTraceEvent` is being called; the `agentAttempt` / `llmCall` slots are the ones the markdown orchestrator skipped. The asymmetry is itself useful evidence: the tool works (proven by the milestones), but per-attempt and per-LLM-call calls are *separately* skipped, suggesting the gap is per-call-site obedience rather than a global wiring failure.

- **Workshop-site run is on a different project root** (`workshop-site-71c837164a90` vs `claudeagents-…`); the absence of `trace/` there cannot be explained by a server-process state shared with the D1/O1 runs. It suggests the orchestrator may not be calling `emitTraceEvent` at *any* milestone for some runs, not just at `agentAttempt` boundaries.

- **Recovery substrate is silently broken on these runs.** `reconstructRecoveryState` is documented (SKILL.md line 312, R7 line 110) to derive per-role attempt counts from `agentAttempt` events with no fallback. A `--recover` against any of these three runs would read zero attempts, which compounds the symptom rather than surfaces it. A fix-planner needs to be aware that today's recovery code does not assert "the trace it is reading is non-degenerate".

## Confidence

high — the reproduction commands produce exactly the outputs the report predicts, the source code matches the cited mechanism end-to-end, and the framework's own R7 spec and roadmap explicitly classify this gap as a known un-CI-tested risk.

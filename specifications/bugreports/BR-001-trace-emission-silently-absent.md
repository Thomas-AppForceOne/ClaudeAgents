# BR-001 — Trace emission silently absent on entire runs

**Status:** Needs verification
**Severity:** Blocker
**Found in run(s):**
- `claudeagents-5f2b0a723ee9/runs/20260601T194010-c238` (O1 — `trace/` and `telemetry/` exist but are empty)
- `claudeagents-5f2b0a723ee9/runs/20260606T214636-1588` (D1 — 7 events total, all `orchestratorMilestone`, ZERO `agentAttempt` / `llmCall` across 4 full sprints)
- `workshop-site-71c837164a90/runs/20260606T195320-b600` (no `trace/` directory at all)
**Filed:** 2026-06-08

## Description

R7 makes trace emission callable as an MCP tool (`emitTraceEvent`); SKILL.md instructs the orchestrator to emit at every agent-attempt boundary. In practice the orchestrator silently skips emission on entire runs, and nothing surfaces the gap.

Concrete shapes of the failure observed:
- The D1 run executed 4 sprints with proposer + contract-reviewer + generator + independent-reviewer + evaluator each — but only 7 `orchestratorMilestone` events landed in `trace/events/`. No `agentAttempt`, no `llmCall`. The downstream consumers (`reconstructRevisionState`, `aggregateSprintSummary`, recovery state) operate on this empty data without erroring.
- The O1 run created `trace/` and `telemetry/` directories then wrote nothing to them.
- The workshop-site run shipped no `trace/` directory at all; instead it produced ad-hoc captured output under `evaluator-logs/` (see BR-012).

This is the v1.0 known-gap "downstream correctness compounds on trace-emission fidelity" manifesting in production. Recovery (O2), revision-scoped budget (E8 § Bounding thrash), and cost rollup (O3) all silently degrade when this happens.

## Steps to reproduce

```bash
# D1 run — confirm zero agentAttempt events across 4 sprints
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260606T214636-1588/trace/events/
# Expect: 0000000000.json .. 0000000006.json (7 files)

for f in /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260606T214636-1588/trace/events/*.json; do
  python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['eventType'])" "$f"
done | sort | uniq -c
# Expect: 7 orchestratorMilestone

# O1 run — confirm empty trace/
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260601T194010-c238/trace/

# Workshop-site — confirm trace dir missing
ls -la /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/ | grep -E 'trace|telemetry'
```

## Root cause (if known)

The orchestrator is markdown executed by Claude, which *can* ignore SKILL.md emission instructions. The framework has no post-attempt invariant that asserts "this agent ran → its `agentAttempt` event landed." The R7 tool exists and works (verified by unit tests in `tests/config-server/tools/run-context.test.ts`), but its *use* is purely advisory.

## Suggested fix

Post-attempt orchestrator-side invariant: at terminal, assert that for every sprint listed in `progress.json` there is at least one `agentAttempt` event per executed role (generator, evaluator at minimum). If the invariant fails, write `terminalReason: "traceEmissionGap"` and surface it. Alternatively, wrap agent spawns in a structural emission-injection that doesn't depend on prompt obedience.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-001-verification.md](BR-001-verification.md) (opus)

Reproduction matches verbatim; root cause holds. Refinements for a fix-planner:

- **Citation slip in the original report.** The R7 unit tests cited as `tests/config-server/tools/run-context.test.ts` actually live at `tests/config-server/tools/trace.test.ts`. The substantive claim (the R7 tool works) is correct.
- **The gap is per-call-site obedience, not global wiring.** Milestone slots of `emitTraceEvent` *did* fire on the D1 run (`clarification-start`, `all-sprints-passed`). Only the `agentAttempt` and `llmCall` slots were skipped.
- **`reconstructRecoveryState` has no degenerate-trace guard** (SKILL.md line 312, R7 line 110). `--recover` against any of the three affected runs would silently read zero attempts.
- **Workshop-site is a different project root**, so its missing `trace/` cannot be explained by shared server-process state — suggests milestones too may be skipped on some runs.

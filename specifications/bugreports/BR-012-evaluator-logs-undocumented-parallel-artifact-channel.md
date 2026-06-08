# BR-012 — `evaluator-logs/` is an undocumented parallel artifact channel outside trace/schema discipline

**Status:** Needs verification
**Severity:** Medium
**Found in run(s):**
- `workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs/` (12 files, 2.4 MB)
- `workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs-B/` (2 files)
**Filed:** 2026-06-08

## Description

The workshop-site run produced two directories with 2.4 MB of ad-hoc captured shell output that fits no documented channel:

```
evaluator-logs/
  c1-c5-head-after-restore.log    2.3 KB
  c1-c5-head-attempt-b.log        2.3 KB
  c1-c5-head.log                  2.3 KB
  c6-baseline-attempt-b.log       32 KB
  c6-baseline.log                 28 KB
  c6-head-restore-attempt-b.log   2.3 KB
  c7-base-attempt-b.json          979 KB
  c7-base-attempt-b.stderr        0 B
  c7-chromium.log                 379 KB
  c7-head-attempt-b.json          979 KB
  c7-head-attempt-b.stderr        0 B
  seed-attempt-b.log              53 B
evaluator-logs-B/
  01-head-clearcache.log
  02-head-mobile.log
```

The filenames imply a per-criterion (c1-c5, c6, c7) and per-attempt (head/baseline/restore/attempt-b) structure that no documented schema covers. The 2 MB of JSON payload (c7-base/head-attempt-b.json) looks like Playwright trace output. None of this appears in the run's trace events.

This is the predictable consequence of the trace channel not accommodating large captured shell payloads: when the evaluator needs to keep the chromium log for later inspection, and the trace event channel has no payload-ref pattern for it, the implementation invents a sidecar directory. The same pattern will recur every time a new evaluator needs to capture bulky output.

Without a documented schema:
- The files are invisible to `--recover` (which only knows about trace + named artifacts).
- The files are invisible to any cross-run aggregator.
- The naming convention is per-run-ad-hoc — `c7-base-attempt-b.stderr` is empty, `c7-base-attempt-b.json` is 979 KB; tomorrow's run might use different scheme.
- 2.4 MB of disk per run accumulates undocumented.

## Steps to reproduce

```bash
# Confirm the directory structure
ls -lh /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs/
ls -lh /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/evaluator-logs-B/

# Confirm trace dir is missing on this run
ls -la /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/ | grep -E 'trace|telemetry'
# Expect: no trace/ or telemetry/ entries

# Confirm no doc mentions evaluator-logs/
grep -rln 'evaluator-logs' /Users/taa/AppForceOne/projects/ClaudeAgents/specifications/ /Users/taa/AppForceOne/projects/ClaudeAgents/agents/ /Users/taa/AppForceOne/projects/ClaudeAgents/skills/ 2>/dev/null
# Expect: nothing or only a passing mention
```

## Root cause (if known)

T1's run-trace events are inlined-payload (small, integral). For large captured payloads (chromium logs, browser traces, big test stdout) it documented a `*Ref` hashed-payload-file pattern, but no actual payload-ref directory shape is specified for the evaluator's command output. The evaluator agent prompt or its captured-output handler appears to have rolled its own.

Note: this is related to BR-001 (the same workshop-site run also has no `trace/` directory) — it is plausible the orchestrator skipped trace emission entirely and `evaluator-logs/` is what survived as a fallback.

## Suggested fix

1. Specify a typed channel for captured command output as a trace-event class: `capturedCommandOutput` with payload-ref to a file under `trace/payloads/<sha256-prefix>.{log,json}`. The event carries `{commandLine, exitCode, durationMs, payloadRef}`; the file under `trace/payloads/` carries the bulk.
2. Retire `evaluator-logs/` and `evaluator-logs-B/` directories; reject them at terminal as `unexpectedArtifact` harness conditions (BR-009).
3. Bound payload-ref directory size: warn at 10 MB per run; abort at 100 MB.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-012-verification.md](BR-012-verification.md) (sonnet)

Both `evaluator-logs/` (12 files, 2.4 MB) and `evaluator-logs-B/` (2 files) exist; the string `evaluator-logs` appears in zero spec/agent/skill file. T1's `trace/payloads/` channel covers LLM prompt/response blobs only — no event class exists for captured shell or browser output. Refinements:

- **Only one project root is affected** (`workshop-site-71c837164a90`). The other two roots have no `evaluator-logs*`. The writing logic is invisible in the spec layer — no agent file references the directory name.
- **Naming is already inconsistent within the single run.** `evaluator-logs/` uses criterion prefixes (`c1-c5`, `c6`, `c7`); `evaluator-logs-B/` uses numeric prefixes (`01`, `02`).
- **Asymmetric capture observed.** `c7-base-attempt-b.stderr` is 0 bytes while the `.json` sidecar is 979 KB — the "tomorrow's run might do it differently" concern from the report is already happening today.
- **A fix-planner should look for the writing logic in the evaluator agent's inline tool-call patterns**, since neither `agents/gan-evaluator.md` nor any skill file mentions `evaluator-logs`.
- **Cross-references BR-009.** Same missing typed-channel problem; fix together.

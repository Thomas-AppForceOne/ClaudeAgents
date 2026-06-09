# BR-010 — Agents shipped mid-run are not invoked on subsequent sprints of that same run

**Status:** Closed pending by-design ruling — not actionable as a fix until F7 snapshot-freshness semantics are clarified (intentional invariant vs. accidental restriction). Reopen as a fix only if the ruling lands on "accidental." See [FIX-ORDER-PLAN.md](FIX-ORDER-PLAN.md) Phase 0.
**Severity:** Medium
**Found in run(s):**
- `ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0` (E8 — `gan-reviewer-independent` shipped in sprint 1; no `sprint-2..6-independent-review-A.json` files exist)
**Filed:** 2026-06-08

## Description

When a sprint ships a new agent or evaluator behavior, the orchestrator does not start using it on subsequent sprints of the same run. As a result, the run that introduces a new role gets no exercise of that role until a *subsequent* run picks it up.

Specifically observed in the E8 implementation run:
- Sprint 1 shipped `agents/gan-reviewer-independent.md`, `schemas/independent-review-v1.json`, and the bundled-schemas wiring.
- Sprints 2-6 of the same run touched the SKILL.md renegotiation loop, the trace event, the evaluator rewrite, and the planted-defect suite.
- No `sprint-2-independent-review-A.json` through `sprint-6-independent-review-A.json` exists in the run dir. The newly-shipped reviewer was never invoked on its own implementation work.
- Subsequent runs (M4, O2-recovery, workshop-site) all use it correctly — so the mechanism works, just not on the run that ships it.

This means every gate-strengthening PR self-certifies without exercising the new gate. It is the structural reason BR-006 (contract-reviewer rubber-stamps) and the original E8-motivation pattern keep recurring on the very PRs that try to fix them.

## Steps to reproduce

```bash
# Confirm the agent ships in E8 run
ls /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/ | grep independent-review
# Expect: (nothing — no independent-review files in E8's own run)

# Confirm the same agent is invoked in subsequent runs
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T163227-e220/ | grep independent-review
# Expect: sprint-1-independent-review-A.json, sprint-1-independent-review-B.json
```

## Root cause (if known)

The orchestrator reads agents from the worktree at startup or per-spawn, but lacks a mechanism for "hot-reload after this sprint's diff lands new agent files." Even if it had one, the spec lifecycle would forbid using a not-yet-shipped agent to grade itself — chicken-and-egg.

## Suggested fix

Bootstrap-invoke-in-advisory-mode: when a sprint's diff adds a file under `agents/` or `schemas/`, the orchestrator MAY (configured by `safety.bootstrapAdvisory`, default ON) invoke the new agent in *advisory* mode on the *next* sprint of the same run. Advisory output does not gate and does not feed renegotiation; it lands in `sprint-N-advisory-{role}.json` for human review. This preserves the spec-lifecycle invariant (the new agent never gates its own implementation sprint) while exercising it once before the run completes.

Alternative or complement: a release-gate CI step (per BR-011 / `gan health`) that re-runs the calibrated planted-defect suite against the post-sprint loop whenever a PR modifies any path under `agents/`, `skills/gan/`, or `schemas/*review*.json`.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-010-verification.md](BR-010-verification.md) (opus)

The E8 implementation run (`20260530T231724-5cc0`) shipped the independent reviewer + schema + bundled wiring in sprint 1 but produced **zero** `sprint-N-independent-review-A.json` artefacts across all six of its sprints. Subsequent runs in other projects do invoke the reviewer, confirming the mechanism works once a fresh `/gan` invocation re-captures the snapshot. Refinements:

- **All six E8 sprints passed first-try** (15/15, 17/17, …, 20/20 criteria). Even with the reviewer live, the renegotiation loop would have had nothing to escalate (per the renegotiation-loop spec, reviewer findings only matter when blocker/warning findings map to no existing criterion). The bug is structural — the file simply doesn't exist — independent of whether the reviewer would have flagged anything.
- **The E8 run's `trace/` directory is empty** (this project did not have trace events wired through the spawn lifecycle yet) — so on-disk artefact absence is the only available signal. It is sufficient but does mean a "did we spawn it?" log trail is unavailable.
- **The exact sprint→slice mapping in E8** (which sprint touched which deliverable) was not enumerated during verification. The load-bearing observation is the absence of `sprint-N-independent-review-*.json` for every N from 1–6.
- **Run-data is in `~/.gan-runs-data`** (centralized per F7), not in `.gan-state/` within the worktree.

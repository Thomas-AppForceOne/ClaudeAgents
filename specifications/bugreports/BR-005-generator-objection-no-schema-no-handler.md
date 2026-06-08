# BR-005 — Generator-objection artifact has no schema and is not consumed by the orchestrator

**Status:** Needs verification
**Severity:** High
**Found in run(s):**
- `claudeagents-5f2b0a723ee9/runs/20260531T195539-9f56/sprint-3-objection-A.json`
**Filed:** 2026-06-08

## Description

The generator can write a structured objection when the current contract is unsatisfiable (e.g. the contract's `affectedFiles` allowlist conflicts with a `tests_pass_no_regression` blocker because pre-existing guard tests live outside the allowlist). This is genuinely valuable behavior — it surfaces a real cross-spec interaction failure as a structured artifact rather than as a silent loop or as a generator that breaks scope.

Observed in O2-recovery sprint 3:
- `sprint-3-objection-A.json` was written with `{sprintNumber, attempt, target, reason, proposedChange}`.
- The reason cited two pre-existing guard tests (`tests/installer/version-bump.test.ts` and `tests/specifications/roadmap-e8-flipped.test.ts`) whose assertions become false on the current sprint's diff.
- The proposed change was concrete: add the two test files to `affectedFiles` and roll forward their assertions.
- The orchestrator did **not** route this back to the contract-proposer for re-spec; no new contract revision was written from the objection.
- The run terminated as `complete` despite the objection sitting unread.

The artifact has no schema (`schemas/generator-objection-v1.json` does not exist) and no documented handler. Future generators may write differently-shaped objections; current orchestrators ignore them.

## Steps to reproduce

```bash
# Confirm the objection was written
cat /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T195539-9f56/sprint-3-objection-A.json

# Confirm no schema exists
ls /Users/taa/AppForceOne/projects/ClaudeAgents/schemas/ | grep -i objection
# Expect: (nothing)

# Confirm the run terminated as complete despite the objection
python3 -c "
import json
p = json.load(open('/Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T195539-9f56/progress.json'))
print(p['status'], p['terminalReason'])
"
# Expect: complete complete
```

## Root cause (if known)

The objection mechanism appears to have been added to the generator agent prompt at some point without a corresponding orchestrator-side handler or schema. Without `schemas/generator-objection-v1.json`, no validation gates the artifact; without a documented orchestrator route ("on objection: feed `{target, reason, proposedChange}` back to the contract-proposer as a renegotiation trigger"), the artifact dead-letters.

## Suggested fix

1. Author `schemas/generator-objection-v1.json` with required fields `{sprintNumber, attemptLetter, target, reason, proposedChange, severity}` and validate at write.
2. SKILL.md: on encountering `sprint-N-objection-{letter}.json`, the orchestrator treats it as a renegotiation trigger (route to proposer with the objection as `payloadKind: "objection"`, distinct from `surviving-findings`). E8 § 2 already names "objection" as one of the four payload kinds the proposer accepts — wiring is the gap.
3. Surface the objection in `progress.json.objections[]` so cross-run analysis can count them.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-005-verification.md](BR-005-verification.md) (opus)

Reproduction matches exactly. `skills/gan/SKILL.md` contains **zero occurrences of "objection"** across 471 lines; no source file under `src/` or `scripts/` reads `sprint-*-objection-*.json`. Refinements:

- **`progress.json` shows `currentAttempt: 2`** on the affected sprint. The most likely interpretation: the generator re-ran against the *original* sprint-3 contract on attempt B, with no proposer involvement and no revised contract. The orchestrator is treating OBJECTION-RAISED stdout as just another failed attempt.
- **Legacy `skills/gan/schemas/objection.schema.json` was retired by E1** (`retirements.md:23,40`) with an explicit "rewrite or drop" decision — the absent schema may be a permanent unintentional drop rather than an oversight.
- **`schemas/progress-v1.json` has no `objections[]` field**, so cross-run objection counts currently require per-run directory scans.
- **No test fixture exercises end-to-end objection handling** — the proposer test only asserts the prompt's "Inputs" section structurally.

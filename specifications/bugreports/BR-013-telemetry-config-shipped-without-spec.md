# BR-013 — `telemetry/config.json` ships ad-hoc without spec coverage; matches T4 (v1.1)

**Status:** Needs verification
**Severity:** Medium
**Found in run(s):**
- `workshop-site-71c837164a90/runs/20260608T171254-22af/telemetry/config.json` (the only run that writes this file out of 8 examined)
**Filed:** 2026-06-08

## Description

The latest workshop-site run (planning state, started 2026-06-08) created `telemetry/config.json` containing the resolved configuration snapshot at run start:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "capturedAt": "2026-06-08T17:13:00.000Z",
    "runId": "20260608T171254-22af"
  },
  "resolvedConfig": {
    "additionalContext": { "planner": [], "proposer": [] },
    "apiVersion": "0.6.0",
    "discarded": [],
    "issues": [],
    "modules": { "docker": { ... } },
    "overlay": {},
    "runtimeMode": { "noProjectCommands": false },
    "schemaVersions": { "overlay": 1, "stack": 1 },
    "stacks": { "active": ["web-node"], "byName": { ... } },
    "warnings": []
  }
}
```

This is **exactly the T4 (`T4-run-configuration-record.md`, v1.1) specification's payload**: framework version, config digest, active stacks, agent roster, trust posture, resolved harness knobs. It is shipping ad-hoc, in advance of the spec, in only 1 of 8 runs.

Two problems:
1. **Inconsistency** — 7 of 8 runs do not produce this file; cross-run aggregation that depends on it will fail unpredictably.
2. **Spec authority drift** — T4 is the documented home for this concept. Shipping an unspecified file with the same payload risks T4 being authored around an existing-but-incompatible implementation, or the implementation diverging by the time T4 lands.

## Steps to reproduce

```bash
# Confirm only 1 of 8 runs has telemetry/config.json
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d)
  [ -f "$d/telemetry/config.json" ] && echo "$name: HAS config.json" || echo "$name: missing"
done
# Expect: 1 has it, 7 missing

# Confirm payload matches T4's shape
cat /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260608T171254-22af/telemetry/config.json
grep -A 50 'runConfiguration' /Users/taa/AppForceOne/projects/ClaudeAgents/specifications/T4-run-configuration-record.md
```

## Root cause (if known)

T4 (v1.1) was authored as a future spec; some component (likely a recent SKILL.md or orchestrator change) implemented its central payload early without rolling the spec forward to draft+shipped. Either deliberate (low-cost feature snuck in) or accidental (a session-config snapshot incidentally landed at the documented path).

## Suggested fix

Pick one of two paths and execute:
1. **Pull T4 forward into v1.0**: now that the implementation appears to work, finish the SKILL.md → file → schema chain, validate at write, ensure all runs emit it (not just 1 of 8). Rolls one item out of v1.1 with low cost.
2. **Remove the ad-hoc file**: until T4 ships its spec text and schema, this file should not exist in run state. Either path resolves the inconsistency.

The current half-shipped state is worse than either endpoint.

---

## Verification update (2026-06-08)

**Verdict:** NOT-REPRODUCIBLE
**Confidence:** high
**Verification report:** [BR-013-verification.md](BR-013-verification.md) (sonnet)

The bug report's three claims are each wrong:

- **`telemetry/config.json` is fully specified** by the shipped **O3** spec (`O3-telemetry-semantics.md`, PR #39 merged 2026-06-06). The schema at `schemas/telemetry-config-v1.json` matches what the files contain exactly. The "no spec coverage" claim is false.
- **T4's `runConfiguration` payload is completely different.** T4 defines a *trace event* with `frameworkVersion`, `configDigest`, `roles`, `trustRung`, `safetyKnobs` — none of which appear in `telemetry/config.json`. O3 and T4 are complementary specs for different artefacts; the "exact match" claim is incorrect.
- **The 7 runs without the file all predate the O3 merge timestamp.** This is the expected pre/post-O3 split, not an inconsistency bug. (Also: the count is 2 of 9 present, not 1 of 8.)

**Recommended disposition:** close as not-reproducible / wrong premise. Refile any T4-specific concerns when T4 ships in v1.1.

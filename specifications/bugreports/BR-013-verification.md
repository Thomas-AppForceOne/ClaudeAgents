# BR-013 — Verification

**Verifier model:** sonnet
**Verdict:** not-reproducible
**Verified at:** 2026-06-08T00:00:00.000Z

## Summary

The bug report claims `telemetry/config.json` ships ad-hoc without spec coverage and its payload matches the v1.1 T4 spec. Both claims are false: O3 (`O3-telemetry-semantics.md`, shipped PR #39 on 2026-06-06) is the authoritative specification for `telemetry/config.json`, and the actual file payload matches the O3 schema exactly — not T4's unrelated `runConfiguration` trace-event shape. The 7-of-9 runs that lack the file predate the O3 merge, making the absence fully expected.

## Reproduction evidence

**Step 1 — Count runs with `telemetry/config.json`**

```
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d); proj=$(basename $(dirname $(dirname $d)))
  [ -f "$d/telemetry/config.json" ] && echo "$proj/$name: HAS config.json" || echo "$proj/$name: missing"
done
```

Exit code: 0. Output:

```
ClaudeAgents-dea5f7879cf0/20260530T231724-5cc0: missing
claudeagents-5f2b0a723ee9/20260531T163227-e220: missing
claudeagents-5f2b0a723ee9/20260531T195539-9f56: missing
claudeagents-5f2b0a723ee9/20260601T194010-c238: missing
claudeagents-5f2b0a723ee9/20260606T180005-70ef: missing
claudeagents-5f2b0a723ee9/20260606T214636-1588: missing
claudeagents-5f2b0a723ee9/20260608T173536-01d3: HAS config.json
workshop-site-71c837164a90/20260606T195320-b600: missing
workshop-site-71c837164a90/20260608T171254-22af: HAS config.json
```

The report's claimed count of "1 of 8" is wrong on two dimensions: there are **9** runs total (not 8), and **2** of them have the file (not 1). The second file exists at `claudeagents-5f2b0a723ee9/20260608T173536-01d3`.

**Step 2 — Read the payload and compare to T4**

```
cat /Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260608T171254-22af/telemetry/config.json
```

Produces exactly the JSON shown in the bug report (`envelope.{schemaVersion,capturedAt,runId}` + `resolvedConfig` with all 10 fields). Both files with `config.json` validate against `schemas/telemetry-config-v1.json` — all 10 required `resolvedConfig` fields (`apiVersion`, `schemaVersions`, `runtimeMode`, `stacks`, `overlay`, `discarded`, `additionalContext`, `issues`, `warnings`, `modules`) are present, no extras.

The T4 spec (`specifications/T4-run-configuration-record.md`) specifies a `runConfiguration` **trace event** with a completely different shape: top-level fields `frameworkVersion`, `configDigest`, `activeStacks`, `roles`, `trustRung`, `tracePayloadsMode`, `safetyKnobs`, and an envelope with `sequenceNumber` and `eventType`. None of these fields appear in the actual `telemetry/config.json`. The bug report's claim of an "exact match" to T4's payload is incorrect.

**Step 3 — Confirm runs without the file predate O3**

O3 merged at commit `3a030a0` on **2026-06-06 23:28:46 +0200** (21:28:46 UTC). All 7 runs lacking the file have run-dir timestamps that predate this merge:

- `20260530T*`, `20260531T*`, `20260601T*` — clearly pre-O3 (days earlier)
- `20260606T180005`, `20260606T195320` — 18:00 and 19:53 local (+0200), both before 23:28 local
- `20260606T214636` — 21:46 local (+0200), still before 23:28 local

Both runs that have the file are dated `20260608T*` — two days after O3 shipped.

## Root-cause assessment

The root-cause claim does not hold. The report hypothesizes that `telemetry/config.json` was "shipped early without rolling T4 forward." In fact:

- **O3 (`O3-telemetry-semantics.md`) is the spec that governs `telemetry/config.json`.** O3 explicitly defines the file, its write-once semantics, the schema (`schemas/telemetry-config-v1.json`), the envelope shape, and that `resolvedConfig` must carry all 10 `getResolvedConfig()` fields. O3 is listed as shipped in `specifications/roadmap.md` (entry 23: `✅ O3 — telemetry semantics. Shipped PR #39.`).

- **T4 (`T4-run-configuration-record.md`) is a v1.1 spec for a different artifact.** T4 specifies a `runConfiguration` event emitted into the run trace (`trace/` directory), not into `telemetry/config.json`. The two specs are sibling concerns that were designed together (O3 § "Relationship to T1/T4") but govern entirely distinct outputs.

- **The inconsistency across runs is the expected pre/post-O3 split**, not evidence of ad-hoc implementation. O3's implementation writes the file; pre-O3 runs never produced it.

The bug report appears to have been authored without checking whether O3 had already shipped, and conflated O3's `telemetry/config.json` artefact with T4's `runConfiguration` trace event because both capture resolved configuration information at run start.

## Concerns / caveats

1. **Run count error.** The report states "1 of 8 runs" but the data shows 2 of 9. A fix-planner should not rely on the report's count.

2. **T4 vs O3 conflation is understandable but consequential.** O3 and T4 both capture run configuration, but they serve different consumers: O3's `telemetry/config.json` is a standalone summary artefact for operators; T4's `runConfiguration` event goes into the structured run trace for tools like V1's cross-run comparison harness. They are complementary, not duplicates.

3. **No spec authority drift.** The report's "spec authority drift" concern does not apply — O3 is the authority and T4 does not overlap with it. When T4 ships in v1.1, it adds a trace event; it does not supersede or conflict with O3's `telemetry/config.json`.

4. **No action on missing file for pre-O3 runs.** The 7 runs without `config.json` cannot retroactively gain it. This is a one-time historical artifact of the O3 implementation landing mid-project.

## Confidence

High — the spec (`O3-telemetry-semantics.md`), the schema (`schemas/telemetry-config-v1.json`), the roadmap entry for O3, the git commit timestamp for PR #39, and the run-dir timestamps all converge on the same conclusion with no ambiguity.

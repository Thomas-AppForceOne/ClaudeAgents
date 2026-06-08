# BR-016 — Verification

**Verifier model:** sonnet
**Verdict:** confirmed
**Verified at:** 2026-06-08T18:11:28Z

## Summary

The `schemaVersion` field is inconsistently present across artifact files in all 8 runs: `progress.json` carries it in 2 of 8 runs, `independent-review-*.json` carries it in 1 of 10 files (and even within the same run — 1588 — sprint-1 has it while sprints 2–4 do not). No `evaluator-evidence-bundle` artifact has `schemaVersion`. The published schemas do not declare `schemaVersion` as a required top-level field in the main artifact schemas (`progress-v1`, `independent-review-v1`, `evaluator-evidence-bundle-v1`), confirming the root cause.

## Reproduction evidence

**Step 1 — `progress.json` survey:**

```
20260530T231724-5cc0 progress.json: schemaVersion=MISSING
20260531T163227-e220 progress.json: schemaVersion=MISSING
20260531T195539-9f56 progress.json: schemaVersion=MISSING
20260601T194010-c238 progress.json: schemaVersion=1
20260606T180005-70ef progress.json: schemaVersion=MISSING
20260606T214636-1588 progress.json: schemaVersion=1
20260606T195320-b600 progress.json: schemaVersion=MISSING
20260608T171254-22af progress.json: schemaVersion=MISSING
```

Exit code: 0. Result: `schemaVersion=1` present in 2 of 8 runs (c238, 1588), absent in 6. Matches bug report exactly.

**Step 2 — `independent-review-*.json` survey:**

```
20260531T163227-e220/sprint-1-independent-review-A.json: MISSING
20260531T163227-e220/sprint-1-independent-review-B.json: MISSING
20260531T195539-9f56/sprint-1-independent-review-A.json: MISSING
20260606T180005-70ef/sprint-1-independent-review-A.json: MISSING
20260606T180005-70ef/sprint-2-independent-review-A.json: MISSING
20260606T214636-1588/sprint-1-independent-review-A.json: 1
20260606T214636-1588/sprint-2-independent-review-A.json: MISSING
20260606T214636-1588/sprint-3-independent-review-A.json: MISSING
20260606T214636-1588/sprint-4-independent-review-A.json: MISSING
20260606T195320-b600/sprint-1-independent-review-A.json: MISSING
```

Exit code: 0. Result: only 1 of 10 files has `schemaVersion=1` (run 1588, sprint-1 only). Bug report says "1 of 5 runs"; confirmed — only 1 run (1588) has any independent-review with `schemaVersion`, and even within that run the field only appears in sprint-1, not sprints 2–4.

**Step 3 — evaluator-evidence-bundle survey (supplemental):**

All 8 `sprint-*-evidence-*.json` files (including `sprint-*-evaluator-evidence-*.json` variants): `schemaVersion=MISSING` in every case. Matches bug report.

**Step 4 — telemetry/config.json (supplemental):**

Both existing `telemetry/config.json` files carry `envelope.schemaVersion=1`. Matches bug report. The `telemetry-config-v1` schema requires `envelope.schemaVersion` (within `envelope.required`), making telemetry the one place this field is consistently enforced.

## Root-cause assessment

The root cause is confirmed. The relevant schemas at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/`:

- **`progress-v1.json`**: `additionalProperties: false`; `schemaVersion` is not in `properties` and not in `required`. The two progress.json artifacts that carry `schemaVersion=1` (c238 and 1588) would therefore **fail** strict AJV validation against this schema. Those artifacts also carry extra non-schema fields (`startedAt`, `endedAt`, `subject`, `spec`, `passes` in c238; `sprints[]` in 1588) and are missing several required fields (e.g. `totalSprints`, `completedSprints`, `projectRoot`, `runBranch`, `baseBranch`, `startingBranch`, `overlaysAtSnapshot`, `recoveryHistory`). They represent a transitional/earlier artifact shape, not the current schema-conforming shape.
- **`independent-review-v1.json`**: `additionalProperties: false`; `schemaVersion` absent from `properties` and `required`. The reviewer agent prompt (`agents/gan-reviewer-independent.md`) shows the expected output shape without a top-level `schemaVersion` field, and the `summary` block uses `blockers`/`warnings`/`advisories`/`dropped` (plural). The 1588 sprint-1 review that has `schemaVersion=1` also has non-conforming fields (`title` per finding, `summary.blocker`/`warning`/`advisory` singular) and is missing required fields (`category`, `file`, `line` per finding).
- **`evaluator-evidence-bundle-v1.json`**: `additionalProperties: false`; `schemaVersion` entirely absent. No artifact has ever carried it.
- **`telemetry-config-v1.json`** and **`telemetry-outcome-v1.json`**: `schemaVersion` lives inside the nested `envelope` object, which is required. This is a structurally different placement from a bare top-level `schemaVersion`, and it is the only case with consistent enforcement backed by a schema `required` constraint.
- **`module-manifest-v1.json`** and **`module-config-docker-v1.json`**: These two schemas are the only ones that require a top-level `schemaVersion` (as `const: 1`). No cross-schema convention enforces the pattern uniformly.

The agent write paths are inconsistent: the clarifier agent (`agents/gan-clarifier.md`) includes `schemaVersion: 1` in its YAML frontmatter example; the independent reviewer agent does not include `schemaVersion` in its JSON shape example; and neither schema nor validation enforces its presence for the three main runtime artifacts.

## Concerns / caveats

1. **Validation paradox.** The two `progress.json` files that DO carry `schemaVersion=1` (c238 and 1588) would actually **fail** strict schema validation because `progress-v1.json` declares `additionalProperties: false` and has no `schemaVersion` property. A fix-planner adding `schemaVersion` to the schema must therefore do it in a way that is backward-compatible with the 6 conforming artifacts that currently omit it — either making it optional, or handling the migration as a breaking change.

2. **The "schemaVersion=1 means conforming to v1 schema" assumption is broken in the current artifacts.** Both c238 and 1588 carry `schemaVersion=1` in `progress.json` but are missing 9–11 of the schema's `required` fields. The schemaVersion stamp here says nothing trustworthy about schema conformance.

3. **Within-run inconsistency.** Run 1588 shows `schemaVersion=1` only in sprint-1's independent review; sprints 2–4 of the same run omit it. This suggests the field was written by an LLM agent acting on its own initiative in sprint-1 (possibly because the prompt example included it) and then not written in subsequent sprints — exactly the "some agent prompts include it as an example, others do not" root-cause sentence in the bug report.

4. **Telemetry uses an `envelope` wrapper rather than bare top-level `schemaVersion`.** Any cross-schema convention for non-telemetry artifacts should decide whether to match the `envelope` pattern or use a bare top-level field.

5. **Evidence bundle count.** The bug report says "5" independent-review runs; the actual count of files is 10 across 5 runs (e220 has A+B, 70ef has 2 sprints, 1588 has 4 sprints). The "1 of 5" wording refers to 1 of 5 distinct run directories, which is accurate.

## Confidence

high — The reproduction commands produced unambiguous output matching all claims in the bug report, and the schema files were inspected directly to confirm the absence of `schemaVersion` from `required` in all three cited schemas.

# BR-016 — `schemaVersion` field inconsistently present across artifact files

**Status:** Needs verification
**Severity:** Low
**Found in run(s):** All 8 runs — `schemaVersion` present on some artifact files, absent on others, with no clear rule
**Filed:** 2026-06-08

## Description

The framework's schema-versioning ruling (roadmap § "Schema-versioning ruling (pre-v1.0)") says additive changes stay on `vN` and breaking changes force `vN+1`. The artifacts the framework writes should carry `schemaVersion` on their face so consumers can verify what they are parsing.

In practice:
- `progress.json`: `schemaVersion: 1` present in 2 of 8 runs (O1 `c238`, D1 `1588`); absent in the other 6 (including the original E8 run and the latest workshop runs).
- `independent-review-A.json`: `schemaVersion: 1` present in 1 of 5 (D1); absent in the other 4 — despite all 5 nominally targeting `independent-review-v1`.
- `evaluator-evidence-bundle-v1.json` artifacts (`sprint-N-evidence-A.json` / variants): no `schemaVersion` field observed in any of the 8 runs examined.
- `telemetry/config.json`: carries `envelope.schemaVersion: 1`.

The published schemas under `/Users/taa/AppForceOne/projects/ClaudeAgents/schemas/` do not consistently require `schemaVersion` as a top-level required field. Consumers cannot tell from a given JSON file alone which schema revision it was written under.

When a future additive change extends `independent-review-v1` (per the additive-stays-`vN` ruling, no version bump), a consumer reading `findings: [...]` cannot tell whether the absence of a new field means "the old shape" or "the new shape with no instances of the new field." A `schemaVersion: 1` stamp, combined with a per-revision changelog, makes this resolvable.

## Steps to reproduce

```bash
# Confirm inconsistent presence
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d)
  if [ -f "$d/progress.json" ]; then
    sv=$(python3 -c "import json; d=json.load(open('$d/progress.json')); print(d.get('schemaVersion','MISSING'))" 2>/dev/null)
    echo "$name progress.json: schemaVersion=$sv"
  fi
done

# Same for independent-review
for f in /Users/taa/.gan-runs-data/*/runs/*/sprint-*-independent-review-*.json; do
  sv=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('schemaVersion','MISSING'))" 2>/dev/null)
  echo "$(basename $(dirname $f))/$(basename $f): $sv"
done
```

## Root cause (if known)

The schemas do not declare `schemaVersion` as a required top-level field. The orchestrator's write paths emit it inconsistently — some agent prompts include it as an example, others do not. There is no cross-schema convention enforced.

## Suggested fix

1. Convention: every framework-authored JSON artifact carries top-level `schemaVersion: <integer>` matching the schema file's `vN` suffix (e.g. `independent-review-v1.json` → `schemaVersion: 1`).
2. Declare `schemaVersion` as `required` in each schema (an additive-stays-`vN` change per the ruling — does not force a vN+1).
3. Wire validation through BR-002's write-time enforcement so a missing or wrong `schemaVersion` aborts the write.
4. `gan run summary` reports per-artifact `schemaVersion` and warns on mixed versions in one run.

Foundation for future migrations: the moment any schema bumps to `vN+1`, consumers can read `schemaVersion` and route to the right parser without ambiguity.

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-016-verification.md](BR-016-verification.md) (sonnet)

`progress.json` carries `schemaVersion=1` in 2 of 8 runs; `independent-review-*.json` in 1 of 10 files; **zero** evaluator-evidence-bundle artefacts have it. None of `progress-v1.json`, `independent-review-v1.json`, or `evaluator-evidence-bundle-v1.json` include `schemaVersion` in `required` (or `properties`). Telemetry uses an `envelope.schemaVersion` wrapper. Refinements:

- **Validation paradox.** The two `progress.json` files that DO carry `schemaVersion=1` (c238, 1588) would **fail** strict schema validation because `progress-v1.json` declares `additionalProperties: false` and has no `schemaVersion` property. Any fix adding `schemaVersion` must be backward-compatible with the 6 conforming artefacts that currently omit it — either optional, or breaking-change-with-migration.
- **`schemaVersion=1` is currently *negative* evidence of conformance.** Both c238 and 1588 carry the stamp but are missing 9–11 required fields. The stamp says nothing trustworthy about schema conformance today.
- **Within-run inconsistency.** Run 1588 emits `schemaVersion=1` only in sprint-1's independent review; sprints 2–4 of the same run omit it. Suggests sprint-1 was written by an LLM imitating a prompt example, with no enforcement afterwards.
- **Cross-schema convention decision required.** Telemetry artefacts use an `envelope.schemaVersion` wrapper; non-telemetry artefacts have a bare top-level slot at most. Pick one before tightening the schemas.
- **File count.** The report's "1 of 5" refers to 1 of 5 *run directories* (actual file count is 10 across 5 directories: e220 A+B; 70ef 2 sprints; 1588 4 sprints).

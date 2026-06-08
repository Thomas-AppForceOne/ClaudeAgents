# BR-011 — Verification

**Verifier model:** sonnet
**Verdict:** partially-valid
**Verified at:** 2026-06-08T00:00:00Z

## Summary

The core symptom — large expansion ratios and no external structural validation of `clarified-spec.md` — is confirmed. However the claim that headings "visibly vary across runs" is overstated for the current codebase: 7 of 9 runs use the canonical six-section structure, and 6 of the 7 most recent runs additionally carry the `schemaVersion: 1` frontmatter. The no-external-validator claim stands fully; the claimed heading-level variation is concentrated in one anomalous early run, not pervasive.

## Reproduction evidence

**Step 1 — Expansion ratios:**

```
$ for d in /Users/taa/.gan-runs-data/*/runs/*/; do
    name=$(basename $d)
    if [ -f "$d/clarified-spec.md" ] && [ -f "$d/raw-prompt.md" ]; then
      raw=$(wc -c < "$d/raw-prompt.md")
      clar=$(wc -c < "$d/clarified-spec.md")
      echo "$name: raw=$raw clar=$clar ratio=$(echo "scale=1; $clar/$raw" | bc)x"
    fi
  done

20260530T231724-5cc0: raw=41638 clar=41638 ratio=1.0x
20260531T163227-e220: raw=   99 clar= 5020 ratio=50.7x
20260531T195539-9f56: raw=   87 clar= 8263 ratio=94.9x
20260601T194010-c238: raw=   58 clar=12175 ratio=209.9x
20260606T214636-1588: raw=   39 clar=11511 ratio=295.1x   ← matches bug report's D1 example
20260608T173536-01d3: raw=22002 clar=12697 ratio=0.5x
20260606T195320-b600: raw= 2237 clar= 8073 ratio=3.6x
20260608T171254-22af: raw=  644 clar=10245 ratio=15.9x
```

Exit code: 0. The D1 run (1588) 39-byte → 11,511-byte expansion (295×) matches the bug report exactly, as do the 87-byte → 8,263-byte (O2, 9f56, ~94.9×) and 58-byte → 12,175-byte (O1, c238, ~209.9×) examples.

**Step 2 — Heading structure variation:**

```
$ for d in /Users/taa/.gan-runs-data/*/runs/*/; do
    name=$(basename $d); if [ -f "$d/clarified-spec.md" ]; then
      echo "--- $name ---"; grep -E '^## ' "$d/clarified-spec.md" | head -10; fi; done

--- 20260530T231724-5cc0 ---
## Problem
## Proposed change
## Schema and surface additions
## Acceptance criteria
## Version bump (install-affecting)
## Dependencies
## Bite-size note

--- 20260531T163227-e220 ---
## Goal
## In scope
## Out of scope
## Assumptions
## User actions
## Constraints

--- 20260531T195539-9f56 ---
[same 6 canonical sections]

--- 20260601T194010-c238 ---
[same 6 canonical sections]
[... all remaining runs: same 6 canonical sections]
```

Exit code: 0. One run (5cc0, 2026-05-30) has a wholly different heading structure: its `clarified-spec.md` is byte-for-byte identical to its `raw-prompt.md` (the E8 spec file) — a 1.0× ratio with spec-document headings (`## Problem`, `## Proposed change`, etc.) instead of the canonical six. Two runs (e220, 9f56, 2026-05-31) have the canonical six sections but no `schemaVersion: 1` YAML frontmatter. The six most recent runs (c238 through 22af) have both the correct sections and the correct frontmatter.

## Root-cause assessment

The report's root cause — "the clarifier agent prompt names target sections in prose but has no structural validation surface (no JSON schema, no markdown linter, no required-headings check) on the output" — is **confirmed**.

Evidence:

1. **Agent prompt is the only enforcement.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/agents/gan-clarifier.md` lines 99–116 mandate `schemaVersion: 1` frontmatter and "exactly these six sections" as level-2 headings. Lines 199–202 ask the agent to self-confirm at completion. This is in-prompt instruction only — there is no external check.

2. **No JSON schema for `clarified-spec.md` exists.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/schemas/` contains 12 schema files (`api-tools-v1.json`, `overlay-v1.json`, `progress-v1.json`, etc.); none covers `clarified-spec.md`.

3. **No lint script targets `clarified-spec`.** `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/scripts/` contains `lint-error-text`, `lint-no-spec-ref`, `lint-no-stack-leak`, `lint-stacks`, `lint-status-markers`. None mentions `clarified-spec` or `clarifiedSpec` (confirmed via grep).

4. **The spec and SKILL.md reference a "document schema" that does not exist.** `specifications/E5-spec-clarification.md` lines 148 and 163–166 state that the orchestrator "schema-validates" the clarified spec after edits and evolutions. `skills/gan/SKILL.md` line 409 repeats the same claim. No corresponding implementation artefact (JSON schema, TypeScript validator, or lint script) exists in the codebase. The "document schema" is a design intent, not a shipped artefact.

5. **The 5cc0 run is proof that the absence of enforcement is load-bearing.** Run `20260530T231724-5cc0` has a `clarified-spec.md` that is an exact byte-for-byte copy of its `raw-prompt.md` (the full E8 spec, 41,638 bytes). It carries none of the required structure — no YAML frontmatter, no `## Goal`, no canonical sections — yet nothing in the framework flagged or blocked it.

One detail in the root-cause is slightly imprecise: the agent prompt does explicitly name the required sections (not merely "in prose" — it has a structured enumeration at lines 109–116 and a formal completion self-check at lines 199–202). The gap is that no external/post-write validator enforces them, so the self-check is the only enforcement, and it failed at least once.

## Concerns / caveats

1. **Scope of variation is narrower than described.** The bug report says "each `clarified-spec.md` in the run-data tree visibly varies in section style, depth, and headings." In reality, 7 of 9 runs have the canonical six sections. The pervasive-variation framing is an overstatement that may affect how a fix is scoped — the problem is an enforcement gap, not an observed divergence across all runs.

2. **The 5cc0 anomaly may be a pre-E5 artefact.** Run 5cc0 is dated 2026-05-30; the E5 clarifier was merged 2026-05-25 (commit `a513264`). The `clarified-spec.md` in that run appears to be the raw E8 spec passed verbatim — likely an early run predating the clarifier's current agent instructions or using a pre-schema version of the agent. A fix-planner should decide whether to treat it as a representative failure or as an expected legacy artifact.

3. **Missing `schemaVersion` in e220 and 9f56 is real but partial.** Two May-31 runs have the correct six sections but no `schemaVersion: 1` YAML frontmatter. This is a structural violation but a smaller one than the 5cc0 case. It may indicate the frontmatter requirement was added to the agent prompt after those runs, or that the self-check was not enforcing the frontmatter at that stage.

4. **The "document schema" reference is a spec-design liability.** `E5-spec-clarification.md` and `SKILL.md` both describe schema validation of the clarified spec at the edit-flow and evolution stages. This is currently aspirational (no schema file exists). A fix-planner must decide whether to (a) create the schema and wire it into the orchestrator, (b) remove the spec language, or (c) implement a simpler section-presence lint instead of a full JSON schema — all three are plausible approaches to the same root gap.

5. **The no-op clarifier case (5cc0's 1.0× ratio) is a distinct issue.** The bug report mentions "no measure of did the clarifier actually clarify." The 5cc0 run is the only concrete example, but it is a genuine instance of a no-op clarifier producing structurally invalid output. The fix suggested in the report (detecting a no-op) would catch this, but so would structural validation.

6. **Bug report count discrepancy.** The report says "6 of 8 runs that exercise the clarifier" but the artifact tree has 9 runs total, all with `clarified-spec.md`. This is a minor count discrepancy in the report, likely reflecting the state of the run-data at filing time.

## Confidence

high — the expansion ratios, structural variation, and absence of a `clarified-spec` JSON schema or lint script are all directly verifiable from the on-disk artifacts and codebase; no inference is required.

# BR-011 — `clarified-spec.md` is free-form markdown with no structural validation

**Status:** Needs verification
**Severity:** Medium
**Found in run(s):** All runs that exercise the clarifier (6 of 8)
**Filed:** 2026-06-08

## Description

The clarifier produces `clarified-spec.md` as the contract input for the planner. In some runs it does substantial work — `claudeagents-5f2b0a723ee9/runs/20260606T214636-1588` (D1) expanded a 39-byte prompt ("implement the next task in the roadmap") into an 11,511-byte clarified spec, a ~295× expansion. Other runs expand 87 bytes → 8,263 bytes, or 58 bytes → 12,175 bytes.

The clarifier is now a critical-path component for terse prompts. But the output is free-form markdown:

- No required sections (Goal / In scope / Out of scope / Assumptions / User actions / Constraints — the schema the clarifier prompt advertises).
- No lint that those sections are non-empty.
- No structural extraction surface for downstream consumers (the planner reads the whole markdown, can re-interpret freely).
- No idempotence check (running the clarifier twice on the same prompt could produce subtly different docs, both "valid").
- No measure of "did the clarifier actually clarify" (a no-op clarifier returns the prompt unchanged; nothing flags this).

This makes downstream specifications gradient on whatever shape the clarifier session feels like producing on a given day. Each `clarified-spec.md` in the run-data tree visibly varies in section style, depth, and headings.

## Steps to reproduce

```bash
# Confirm clarifier expansion ratios
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d)
  if [ -f "$d/clarified-spec.md" ] && [ -f "$d/raw-prompt.md" ]; then
    raw=$(wc -c < "$d/raw-prompt.md")
    clar=$(wc -c < "$d/clarified-spec.md")
    echo "$name: raw=$raw clar=$clar ratio=$(echo "scale=1; $clar/$raw" | bc)x"
  fi
done

# Inspect heading structure variation
for d in /Users/taa/.gan-runs-data/*/runs/*/; do
  name=$(basename $d)
  if [ -f "$d/clarified-spec.md" ]; then
    echo "--- $name ---"
    grep -E '^## ' "$d/clarified-spec.md" | head -10
  fi
done
# Expect: visibly different section headings across runs
```

## Root cause (if known)

The clarifier agent prompt (`agents/gan-clarifier.md`) likely names target sections in prose but has no structural validation surface (no JSON schema, no markdown linter, no required-headings check) on the output.

## Suggested fix

1. Define a `schemas/clarified-spec-v1.json` or a markdown-section lint (`scripts/lint-clarified-spec.ts`) that requires named top-level sections in canonical order: `# Goal`, `# In scope`, `# Out of scope`, `# Assumptions`, `# User actions`, `# Constraints`.
2. Validate at write boundary: clarifier output that lacks a required section aborts the run with a structured error (or routes back for re-author).
3. Record `clarifierPromptDigest` (analogous to BR-008) on the produced spec so cross-run analysis can correlate clarifier-version with downstream spec quality.
4. (Optional, separate spec) Skip the clarifier when the input is already a full spec file (`/gan --spec specifications/X.md`) — the M4 case where raw-prompt was `/gan --spec ...` shows the clarifier ran anyway and expanded 58 bytes → 12,175 bytes, much of it likely re-fabricating content from the named spec.

---

## Verification update (2026-06-08)

**Verdict:** partially-valid
**Confidence:** high
**Verification report:** [BR-011-verification.md](BR-011-verification.md) (sonnet)

Expansion ratios (incl. the 295× D1 case) reproduce exactly; no external validator exists. But the **pervasive-variation framing is overstated**:

- **7 of 9 runs use the canonical six-section structure.** 6 of the 7 most recent runs additionally carry the `schemaVersion: 1` frontmatter. The "each `clarified-spec.md` visibly varies" claim is true only for one anomalous early run.
- **The 5cc0 anomaly is likely a pre-E5 artefact.** Dated 2026-05-30; the E5 clarifier merged 2026-05-25. Its `clarified-spec.md` is a verbatim copy of the E8 spec — most plausibly a no-op clarifier or a pre-schema agent version.
- **Two May-31 runs (`e220`, `9f56`) have correct sections but no frontmatter** — a smaller violation.
- **Run count discrepancy.** The report says "6 of 8 runs"; today's data is 9 runs total with `clarified-spec.md`.
- **The "document schema" referenced in `E5-spec-clarification.md` and `SKILL.md` does not exist as a file.** A fix-planner must choose: (a) create the schema and wire it in, (b) remove the spec language, or (c) implement a simpler section-presence lint.
- **The no-op-clarifier signal** (5cc0's 1.0× ratio) is a distinct issue from structural validation; the report mentions it in passing but treats it as one symptom.

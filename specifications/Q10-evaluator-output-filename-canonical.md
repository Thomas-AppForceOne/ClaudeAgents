# Q10 — Canonical evaluator-output filename

## Problem

The evaluator writes a per-sprint per-attempt artefact containing the per-criterion verdicts the orchestrator and downstream consumers join on. Across the framework's own self-build runs four distinct filenames have been observed for the same logical artefact: `sprint-N-evidence-A.json`, `sprint-N-evaluator-evidence-A.json`, `sprint-N-evaluation.json`, and `sprint-N-feedback-A.json`. The newest runs (and the bundled evaluator-evidence schema's description) name the artefact `sprint-N-feedback-A.json`; the older variants persist only because the evaluator agent is an LLM that has drifted from the prompt's stable instruction.

A run that mixes the canonical name with a non-canonical variant (a recovery resume crossing a prompt update) ends up with two artefacts under the same run directory and no machine-mechanical rule to pick one. Downstream consumers (`gan run summary`, recovery, the trace's evidence-bundle verifier) are forced to guess or to read all four. Coexistence is the problem, not the naming preference itself.

The verification report on BR-004 confirms three things: the evaluator prompt has named the artefact `sprint-{N}-feedback-{attempt-letter}.json` since the R7 commit (so the canonical name is already shipped in the prompt layer), `SKILL.md` matches, and the **real enforcement gap is in the H1 confinement hook**. Today the H1 glob `sprint-[0-9]*-feedback-[0-9A-Za-z]*.json` permits the canonical form but neither names the three non-canonical variants nor refuses them with a distinct named-deny — they fall through the default-deny rather than being explicitly rejected. A future evaluator drift toward `-evidence-A.json` therefore surfaces as a generic "outside the run's allowed zones" deny without the trace ever naming why.

## Proposed change

Canonicalise the evaluator-output filename to `sprint-N-feedback-A.json` (or, in source-code form, `sprint-{N}-feedback-{attempt-letter}.json`) across the three layers that name the artefact, and enforce the canonical form at the H1 confinement hook with explicit named-deny rules for the three non-canonical variants so a drift surfaces with a clear deny rather than a default-deny fall-through.

1. **Prompt layer.** `agents/gan-evaluator.md` is the source-of-truth instruction that names the artefact for the evaluator. The canonical form `sprint-{N}-feedback-{attempt-letter}.json` is already present at the relevant lines; this spec pins it.
2. **Orchestrator layer.** `skills/gan/SKILL.md` describes the artefact the orchestrator reads after the evaluator has written it. The canonical form `sprint-N-feedback-A.json` is already present; this spec pins it.
3. **Hook layer.** `scripts/hooks/gan-confine.sh.template` allows write targets under `$GAN_RUN_DIR` only when they match an enumerated pattern. The canonical `sprint-[0-9]*-feedback-[0-9A-Za-z]*.json` arm already exists; this spec adds explicit named-deny arms above the default-deny for the three non-canonical variants so each drift surfaces with a distinct deny message.

The three layers agree on one canonical form. A future change to any one of them is a layer-coordinated edit; a drift in one is a defect the canonicalisation layer catches.

### Hook-layer enforcement

The hook template adds three explicit `case` arms above the default-deny that match the three non-canonical filename shapes directly under `$GAN_RUN_DIR` and exit with a deny message that names the canonical form so the LLM agent that triggered the deny can correct itself on the next attempt. The three shapes:

- `sprint-[0-9]*-evidence-[0-9A-Za-z]*.json` — the original E8-run filename.
- `sprint-[0-9]*-evaluator-evidence-[0-9A-Za-z]*.json` — the M4-run variant.
- `sprint-[0-9]*-evaluation.json` — the O1-run variant.

The arms are placed inside the `is_within "$NORM" "$RUN_DIR_NORM"` block so they only fire when the candidate is directly under the run dir; a same-named file inside the worktree (e.g. as a fixture or a test artefact) is not affected.

The canonical allow arm (`sprint-[0-9]*-feedback-[0-9A-Za-z]*.json`) is unchanged; only the deny coverage is widened.

### Fixture pin

A fixture directory `tests/fixtures/run-state-shapes/feedback-canonical/` carries one canonical filename and the four refused variants so a future drift in either the prompt layer or the hook layer can be detected by a fixture-diff alone.

## Acceptance criteria

1. This spec file exists at `specifications/Q10-evaluator-output-filename-canonical.md`, names the canonical form `sprint-N-feedback-A.json`, and names the three layers (`agents/gan-evaluator.md`, `skills/gan/SKILL.md`, `scripts/hooks/gan-confine.sh.template`) that must agree.
2. `scripts/hooks/gan-confine.sh.template` carries explicit named-deny arms above the default-deny for `sprint-*-evidence-*.json`, `sprint-*-evaluator-evidence-*.json`, and `sprint-*-evaluation.json` directly under `$GAN_RUN_DIR`. The canonical `case` arm still exits 0 for `sprint-N-feedback-A.json`.
3. Vitest test at `tests/installer/confine-hook-feedback-filename.test.ts` spawns the rendered hook with `GAN_RUN_ID=20260609T194234-1bdd` and stub stdin JSON naming each of `sprint-1-evidence-A.json`, `sprint-1-evaluator-evidence-A.json`, and `sprint-1-evaluation.json` as the write target and asserts exit ≠ 0 with a deny message on stderr; spawning with the canonical `sprint-1-feedback-A.json` asserts exit 0.
4. `agents/gan-evaluator.md` and `skills/gan/SKILL.md` together reference the canonical `sprint-N-feedback-A.json` (or `sprint-{N}-feedback-{attempt-letter}.json`) form at least three times across the two files combined, and neither file references the three non-canonical variants in normative text.
5. `tests/fixtures/run-state-shapes/feedback-canonical/` exists with one canonical `sprint-1-feedback-A.json` and four refused-variant filenames (`sprint-1-evidence-A.json`, `sprint-1-evaluator-evidence-A.json`, `sprint-1-evaluation.json`, and a literal-`N` form `sprint-N-feedback-A.json`).

## Dependencies

- Forward-references H1 (the shipped framework-owned confinement hook). The new spec does not edit H1; the hook-template change lands in the live template file the H1 install path writes.
- Forward-references E8 (the shipped independent-review + forced-verification work that introduced the evidence-bundle artefact channel). The artefact's shape is governed by `evaluator-evidence-bundle-v1.json` (and, in this same sprint, the v2 file declared in the sibling spec T5). The filename is what this spec governs.

## Schema additions

None. The filename is an enforcement matter, not a schema concern.

## Out of scope

- Renaming the artefact to a different canonical form. The canonical form is the one already in the prompt and SKILL.md.
- The schema bump that adds the required `evaluatorPromptDigest` field. That work is the sibling T5 spec.

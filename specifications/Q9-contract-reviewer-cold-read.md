# Q9 — Contract-reviewer fresh-context, first-pass script-name resolution, and verdict-shape normalisation

## Problem

The contract-reviewer reads the proposer's draft contract verbatim as its primary input. The draft itself contains the proposer's rationale strings, so the reviewer's audit is anchored on the same narrative the draft was authored from. The independent-reviewer role at the sibling agent boundary has explicit cold-read / fresh-context / skeptical-senior framing; the contract-reviewer prompt has none. The audit history shows the consequence: across one six-sprint self-build run, five of six contract reviews returned an approval with empty `issues[]`, the sixth surfaced a single advisory item explicitly graded "no revision required", and every draft / locked contract pair was byte-identical (no revision rounds ran).

Two structural gaps fall out of the missing cold-read framing:

1. The well-formedness audit (specificity / comprehensiveness / scope / threshold-shape) does not include a structural resolution check against `package.json` at the run's base commit on first-pass drafts. The well-foundedness audit fires only on renegotiation rounds with finding-derived criteria. A first-pass draft that cites a fabricated `npm run X` script (e.g. `npm run test-house-rules` when the real script is `npm run house-rules`) passes the reviewer's audit unchallenged.
2. The verdict-shape varies. Across the same six-sprint run, sprint 1 emitted `decision: "approve"` and sprints 2–6 emitted `verdict: "approved"`. Downstream consumers that hard-code one key would mishandle this; the bundled evaluator-evidence schema and the broader agent-output convention name the field `verdict`.

## Proposed change

`agents/gan-contract-reviewer.md` is amended in three independent ways:

1. **Cold-read framing.** A short fresh-context / cold-read / skeptical-senior framing paragraph is added near the top of the reviewer's role description, structurally placed so the reviewer reads the draft contract without first anchoring on the proposer's rationale strings. The framing is analogous to the independent-reviewer role's cold-read framing — the reviewer is instructed to evaluate every criterion against the spec and the affected files without prejudice from the proposer's narrative.
2. **First-pass script-name resolution.** The well-formedness audit is expanded to include an explicit script-name resolution check on **first-pass drafts** (not only on renegotiation rounds with finding-derived criteria). The reviewer is instructed to walk every `criteria[].description` for backtick-quoted `npm run X` tokens, resolve each against the touched `package.json` at the run's base commit, and surface every unresolved reference as a non-empty entry in the reviewer's `issues[]` output. An unresolved reference blocks approval until the proposer revises.
3. **Verdict-shape normalisation.** The reviewer prompt documents one canonical verdict-shape: `verdict` (string enum). Every example or instruction that emits `decision` is removed. The accepted values are the existing ones — `approved` / `revise` — pinned in the prompt's verdict-shape example. `decision` is the deprecated alternative.

The amendments must not break the file's three named house-rules regions (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`) enforced by the named-region byte-identity check.

## Acceptance criteria

1. `agents/gan-contract-reviewer.md` carries fresh-context / cold-read / skeptical-senior framing structurally placed at the top of the reviewer's role description. The shipped lint CLI for the no-spec-reference / no-stack-leak boundary stays green; the named-region byte-identity check stays green.
2. The well-formedness audit explicitly runs script-name resolution against `package.json` at the run's base commit on first-pass drafts. Any unresolved `npm run X` reference surfaces as a non-empty entry in the reviewer's `issues[]` output, blocking approval.
3. The reviewer prompt documents one canonical verdict-shape: `verdict` (string enum). The shipped prompt contains at least two occurrences of the `"verdict"` JSON key and zero occurrences of the `"decision"` JSON key.
4. Vitest tests at `tests/agents/contract-reviewer-cold-read.test.ts` assert (i) the cold-read framing is present (verbatim phrase grep), (ii) the first-pass script-name-resolution instruction is present, and (iii) the canonical `verdict` shape is documented and `decision` is absent from emitted examples.
5. The shipped lint CLIs for the no-spec-reference, no-stack-leak, named-region byte-identity, and error-text discipline all exit 0 against the worktree.

## Dependencies

- The proposer-side pre-flight name-resolution work is a sibling spec (BR-007). The two land together so the cited-name resolution check fires on both sides — the proposer rejects fabricated names structurally, the reviewer catches them when the proposer's pre-flight is bypassed or extended.
- Cross-references E8 (the spec that introduced the contract-reviewer's well-foundedness audit and the independent-reviewer cold-read framing). The current spec does not edit E8; it adds analogous cold-read framing to the contract-reviewer role.

## Schema additions

None. The verdict-shape pin is documented in the prompt; the bundled evaluator-evidence schema already uses `verdict` and is unchanged.

## Out of scope

- Any change to the evaluator's output schema.
- Cross-run analysis of contract-reviewer first-round-approval rate (a separate measurement-tier surface).
- Renaming the existing well-foundedness audit; only the well-formedness audit gains the first-pass script-name resolution instruction.

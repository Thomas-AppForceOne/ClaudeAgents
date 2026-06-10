# T5 — Evaluator-prompt digest on the evidence bundle

## Problem

The evaluator writes a per-sprint per-attempt evidence bundle the orchestrator and downstream consumers join on for verdicts. The bundle has no record of which evaluator-prompt produced it. When the evaluator-prompt is materially edited mid-run (an E8-class rewrite, a contract clarification, or even a hot-reload between attempts within one sprint), the resulting bundles are indistinguishable from bundles produced under the prior prompt. An operator (or downstream `gan run summary` consumer) cannot tell whether two bundles in the same run, or two bundles compared across runs, are comparable without diffing the prompts by hand.

The framework's own self-build runs reproduce the harm: one E8-era run carries two bundle shapes (a sprint-1 free-form prose shape and a sprints-2-through-6 T1 structured shape), produced under the same orchestrator with no in-band record of the prompt change.

The defect is cross-cutting: it touches the schema (no field exists), the orchestrator (does not stamp anything), the agent prompt (does not emit anything), and the consumer (does not assert on read). Closing it requires a coordinated change across all four layers.

## Proposed change

Introduce the chosen digest field `evaluatorPromptDigest` on the evidence bundle and the analogous digest fields on the two sibling artefacts. The field carries the lowercase SHA-256 hex digest of the relevant prompt file's content at agent-spawn time. The orchestrator computes the digest; the agent forwards it; the consumer asserts it on read.

### Schema layer

- **`schemas/evaluator-evidence-bundle-v2.json` — new file (breaking schema bump).** The v1 file is `additionalProperties: false` at the root and inside the `evidence` definition, so adding a new required field cannot ride on v1 — adding a required field to a strict schema is a breaking change for any consumer that emitted a v1-shaped bundle. v2 declares the required `evaluatorPromptDigest` string at the root with `pattern: "^[0-9a-f]{64}$"` (64 lowercase hex characters — a SHA-256 hex digest), preserves every v1 required field (`attemptLetter`, `sprintNumber`, `criteria`, `verdictSummary`), and keeps `additionalProperties: false` at every level the v1 schema did.
- **`schemas/independent-review-v1.json` — additive optional digest field.** The `reviewerPromptDigest` string is added as an **optional** root property under the same `^[0-9a-f]{64}$` pattern. Optional means no v1 consumer breaks; the change rides on v1 per the additive-stays-`vN` rule.
- **Contract-reviewer output (inline in `agents/gan-contract-reviewer.md`).** The contract-reviewer's review output shape is documented inline rather than in a separate schema file; the additive `contractReviewerPromptDigest` field is documented in this spec's prose and in the agent prompt under the same 64-hex-character SHA-256 contract. No schema file edit is required because no published schema file pins the shape.

### Retirement strategy for v1

`schemas/evaluator-evidence-bundle-v1.json` stays on disk as the **legacy** schema. The orchestrator routes new evaluator output through v2 from this spec forward; v1 is retained only so an existing run's pre-shipped bundle remains parseable. The hard-retire alternative (delete v1) is rejected because the framework's own central-store run dirs (the dogfooding artefacts the team reads as evidence) carry pre-shipped v1 bundles; retaining v1 means an O2 `--recover` flow on an older run does not crash trying to parse its own evidence.

This is the cheaper of the two transitional strategies: v2 is the new write path, v1 is a read-only legacy. No automated migration tool ships; the v1 → v2 distinction is the bundle's own root-level shape (a missing required `evaluatorPromptDigest` is a v1 bundle, by definition).

### Orchestrator layer

`skills/gan/SKILL.md` instructs the orchestrator, at evaluator spawn, to compute the SHA-256 hex digest of the `agents/gan-evaluator.md` file content as installed under `~/.claude/agents/` (so a per-install variation surfaces) and to pass the digest to the spawned evaluator via the spawn context. The orchestrator reads the file with the Read tool, computes the digest, and stamps it on the bundle path at write time.

Verbatim grep-checkable form: the SKILL.md prose contains the literal token `sha256(agents/gan-evaluator.md)` and the literal token `evaluatorPromptDigest` close enough that a reader connects the computation to the bundle field.

### Agent layer

`agents/gan-evaluator.md` is amended so the bundle-output section names the new `evaluatorPromptDigest` field as a required top-level property the evaluator carries forward from the orchestrator's spawn context. The agent does **not** compute the digest itself; if the agent self-computed, an LLM drift in the computation would defeat the audit-trail purpose.

### Consumer layer

A new invariant module at `src/config-server/invariants/evaluator-evidence-digest.ts` asserts on read that any evaluator-evidence bundle reaching the consumer carries `evaluatorPromptDigest` matching `^[0-9a-f]{64}$`. The module exports a single function (dual-callable per R1's rule). The invariant is wired into the `validateAll` read-side path. A vitest test pins the happy path and the missing-digest path.

## Acceptance criteria

1. This spec file exists at `specifications/T5-evaluator-evidence-digest.md`, names the chosen field `evaluatorPromptDigest`, declares the breaking schema bump to `evaluator-evidence-bundle-v2.json` under `additionalProperties: false`, and names the analogous additive digest fields on `independent-review-v1.json` (`reviewerPromptDigest`) and the contract-reviewer's review output (`contractReviewerPromptDigest`).
2. `schemas/evaluator-evidence-bundle-v2.json` exists with `$id: "https://claudeagents.dev/schemas/evaluator-evidence-bundle-v2.json"`, `additionalProperties: false` at every level v1 used it, the required `evaluatorPromptDigest` string with `pattern: "^[0-9a-f]{64}$"`, every v1 required field preserved, and the digest field in the root `required` array.
3. `schemas/independent-review-v1.json` carries an additive **optional** `reviewerPromptDigest` string with `pattern: "^[0-9a-f]{64}$"`; the schema's `additionalProperties: false` discipline is preserved and the field is NOT added to the root `required` array.
4. `npm run publish-schemas:check` exits 0.
5. Vitest test at `tests/config-server/schemas/evaluator-evidence-bundle-v2.test.ts` asserts (i) a bundle with every v1-required field plus a 64-hex `evaluatorPromptDigest` validates under v2; (ii) a bundle missing the digest field fails with a clear schema-mismatch path naming the missing required field; (iii) a bundle with an extra unrelated top-level property fails under `additionalProperties: false`.
6. `skills/gan/SKILL.md` instructs the orchestrator to compute `sha256(agents/gan-evaluator.md)` at evaluator spawn and stamp it under the `evaluatorPromptDigest` field. Grep-checkable: `grep -q 'sha256(agents/gan-evaluator.md)' skills/gan/SKILL.md` matches.
7. `agents/gan-evaluator.md` instructs the evaluator to consume the orchestrator-stamped digest and carry it forward into the bundle under the `evaluatorPromptDigest` field, without self-computing it.
8. `src/config-server/invariants/evaluator-evidence-digest.ts` exports a single dual-callable function asserting the digest field exists with a 64-hex value on read, wired into `validateAll`'s read-side path. A vitest test pins the happy path and the missing-digest path.
9. `package.json`'s `version` field minor-increments (e.g. `0.6.0` → `0.7.0`) since this sprint changes a bundled `schemas/*.json` file and the bundled hook template (the H1 deny coverage in the sibling Q10 spec).

## Dependencies

- Forward-references T1 (the shipped structured-run-trace spec that introduced `evaluator-evidence-bundle-v1.json` with the per-criterion verdict shape). The new v2 schema preserves T1's join-key invariant (`criteria[].name` matches a contract criterion name); the digest is purely additive on top.
- Forward-references E8 (the shipped independent-review + forced-verification spec). E8's review-output schema (`independent-review-v1.json`) gains the optional `reviewerPromptDigest` field additively.

## Schema additions

- `schemas/evaluator-evidence-bundle-v2.json` (new file; required digest field).
- `schemas/independent-review-v1.json` (additive optional digest field).

## Out of scope

- A migration tool that rewrites v1 bundles to v2 shape. v1 stays read-only; v2 is the new write path. No artefact rewrite happens.
- Computing the digest inside the evaluator agent. That responsibility belongs to the orchestrator per the split documented above.
- Surfacing a `gan run summary` warning when a single run mixes more than one digest. The summary read-surface is a v1.1 (T2) deliverable; once it ships it can read the digest field, but this spec does not introduce the warning UX.

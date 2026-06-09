# Q8 — Proposer pre-flight name resolution

## Problem

The contract-proposer authors criteria whose `description` strings name concrete shell tokens — most commonly `npm run X` script invocations the evaluator is expected to execute. When the proposer names a script that does not exist in the run's base-commit `package.json`, the evaluator is forced to choose between (a) failing the criterion for a reason orthogonal to the actual deliverable or (b) grading "intent satisfied" on a fabricated name. Both outcomes blunt the deterministic-verification thesis: the *point* of forced shell execution is that the named command actually runs.

Two pipeline roles let the slip through. The contract-proposer authors `description` as free prose with no instruction to resolve cited script names against the base-commit script map. The contract-reviewer's well-formedness audit (specificity / comprehensiveness / scope / threshold-shape) covers shape, not resolution; its well-foundedness audit only activates on renegotiation rounds with finding-derived criteria. The contract-reviewer cold-read framing is handled by a sibling spec (see "Dependencies"); this spec covers the proposer-side structural pre-flight only.

## Proposed change

Introduce a proposer-side pre-flight that resolves every backtick-quoted `npm run X` token in `criteria[].description` against the base-commit `package.json`'s `scripts` map, surfaces the resolution result as a structured `{name, kind, resolved, hint?}` record, and instructs the proposer to fix every unresolved reference (or strip the unresolved token from the criterion description) before locking the draft. The pre-flight ships as a new MCP tool exposed by the config-server.

The pre-flight is mechanically layered:

1. **Pure-function backbone** at `src/config-server/resolution/criterion-references.ts`. The backbone takes a contract draft (an object with `criteria[].description` strings) plus the contents of a base-commit `package.json` (a JSON string the caller has already read), parses every backtick-quoted `npm run X` token from each description, and returns the structured records. Resolution is `true` iff `X` appears as a key in `package.json`'s `scripts` map. The backbone is the dual-callable surface — the MCP tool and any direct library call resolve to the same function.
2. **MCP tool wrapper** at `src/config-server/tools/validate-criterion-references.ts`. The wrapper accepts a contract draft and a base ref (a git ref the orchestrator supplies), reads the base-commit `package.json` via `git show <baseRef>:package.json` under the `execFile` argument-array discipline (no shell-string interpolation of `baseRef`), and delegates parsing + resolution to the pure-function backbone. The wrapper is registered in the config-server's tool surface; the tool name is `validateCriterionReferences` and its signature lands additively on `schemas/api-tools-v1.json` (the schema stays at v1 per the additive-stays-`vN` rule).
3. **Proposer prompt instruction.** `agents/gan-contract-proposer.md` is amended so the proposer is instructed to invoke `validateCriterionReferences` against its draft before locking and to either (a) fix every unresolved reference or (b) strip the unresolved token from the criterion description. The amendment must not break the file's three named house-rules regions (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`).
4. **Evaluator latitude tightening.** `agents/gan-evaluator.md` is amended so command-backed criteria (criteria whose description names a shell command the evaluator is expected to execute) cannot be passed on "intent satisfied" when the named command fails to resolve. The evaluator is required to record the actual exit code from running the named command; when the command does not exist on the worktree the criterion is `verdict: "blocked"` with the unresolved reference captured in the reason field. The previous "scoring on intent per instructions" license is removed for command-backed criteria.

### Scope of "names"

v1 of the pre-flight covers `npm run X` script-name resolution only. Backtick tokens that are not `npm run X` (plain file paths, exported symbol names, bare commands) are recognised by the parser but ignored — they produce no records and do not gate the draft. File paths and exported symbols have very different cost/precision profiles and are deliberately out of scope for v1. A non-`npm run` backtick token does not surface in the validator's output, and the proposer is not obliged to act on it.

### Parser shape

The parser recognises a token only inside a single pair of backticks (`` ` … ` ``). Inside the backticks, the token must match `npm run [-s ] <script-name>` where `<script-name>` matches `[A-Za-z0-9_:-]+`. The optional `-s` (silent) flag and any flag preceding the script-name are tolerated; the resolved name is the bare script-name only. Multiple tokens per description are reported separately, in source order.

### Hint logic

When a token does not resolve, the record carries an optional `hint` naming the closest matching script in the same `package.json` (Levenshtein distance ≤ 3, ties broken by lexicographic order). When no script is within distance 3 the `hint` field is omitted. The hint is advisory; the proposer chooses whether to substitute or strip.

## Acceptance criteria

1. A new TypeScript module exists at `src/config-server/resolution/criterion-references.ts` exporting a pure function whose signature accepts a contract draft and a `package.json` JSON string and returns an array of `{name, kind: "npmScript", resolved: boolean, hint?: string}` records. The function is dual-callable per the R1 single-implementation rule (no separate copy lives elsewhere).
2. A new MCP tool `validateCriterionReferences` is implemented at `src/config-server/tools/validate-criterion-references.ts`, reads the base-commit `package.json` via an `execFile` argument-array subprocess (no shell-string interpolation of `baseRef`), and delegates resolution to the pure-function backbone.
3. The new tool is registered in the config-server's dispatch table and listed in the additive `schemas/api-tools-v1.json` catalog (the schema stays at v1).
4. `agents/gan-contract-proposer.md` is amended so the proposer is instructed to invoke `validateCriterionReferences` against its draft before locking and to either fix every unresolved reference or strip the unresolved token from the criterion description. The literal token `validateCriterionReferences` appears at least once in the file. The amendment does not break the three named house-rules regions enforced by the house-rules CLI.
5. `agents/gan-evaluator.md` is amended so command-backed criteria cannot be passed on "intent satisfied" when the named command fails to resolve; the criterion is `verdict: "blocked"` with the unresolved reference captured in `evidence`.
6. Vitest tests at `tests/config-server/tools/validate-criterion-references.test.ts` cover (i) all-resolved drafts, (ii) drafts with a fabricated script (`resolved: false`, `hint` present when a close match exists), and (iii) drafts with non-`npm run` backtick tokens (ignored). `npm test -- src/config-server/tools/validate-criterion-references` exits 0.
7. The lints stay green at the sprint boundary: the shipped CLIs for the no-spec-reference, the no-stack-leak, the named-region byte-identity, and the error-text discipline all exit 0 against the worktree.

## Dependencies

- The cold-read / first-pass script-name-resolution / verdict-shape normalisation work on the contract-reviewer side is a sibling spec (the proposer pre-flight closes one half of the same observed defect; the reviewer cold-read closes the other half). The sibling spec is named in the bug-fix subsection of the roadmap.
- Forward-references E8 (the spec that introduced the contract-reviewer's well-foundedness audit). The current spec does not edit E8; it adds a new pre-flight surface the proposer consumes before the contract-reviewer's audits run.

## Schema additions

- `schemas/api-tools-v1.json` — additive entry `validateCriterionReferences` registering the tool's input shape (`contractDraft` object, `baseRef` non-empty string). Stays at v1.

## Out of scope

- File-path and exported-symbol resolution. v1 covers `npm run X` only.
- Cross-run analysis or persistence of the validator's records.
- Any change to the evaluator's verdict-shape contract (the evaluator's output schema is governed by a separate evaluator-artefact spec).

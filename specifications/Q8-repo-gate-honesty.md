# Q8 — Repo-gate honesty

## Problem

The framework's own merge gates do not check what the framework claims they check, which is how a loop-breaking defect (the H4 hook gap) shipped through green CI and stayed green for six merges:

1. **Lint and format are red on develop and gate nothing.** `npm run lint` fails (`tests/config-server/tools/confine-hook-probe.test.ts:83`, forbidden `require()`); `npm run format:check` fails on 176 files. Neither runs in any workflow, while PROJECT_CONTEXT's Tooling section presents both as part of the toolchain.
2. **The API surface has no parity gate.** `trustList` is dispatched and advertised but absent from `schemas/api-tools-v1.json` (the only tool with no declared input shape); `getStackConventions` and `getOverlayField` are schema-catalogued and dispatch-listed but have **no handlers** — advertised-but-`NotImplemented`. The existing `api-tools-v1-r7-entries` check verifies R7's entries only, so none of this fails anything.
3. **Prompt-surface PRs self-certify (BR-010).** A PR that strengthens the gate (new agent, new artifact, new mandated tool) is never exercised by the gate it strengthens before merging — CI has no LLM, and there is no deterministic substitute. Every first-sprint-failure ingredient (hook gap, ungrantable mandates, unwired verdict) was individually lintable; no lint existed.
4. **Splice-point literals are unguarded.** Four agent prompts hardcode `snapshot.mergedSplicePoints["…"]` keys with nothing checking them against the overlay schema — a C3 catalog rename silently breaks prompts.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — extends the locked CI inventory by the sanctioned coordinated-edit path, and the existing maintainer-lint family (`lint-no-stack-leak` pattern).
2. **Composable?** Yes — H4's catalog and E11's grant rule become *enforced* inputs; every future prompt/tool/schema PR rides these gates.
3. **Owns durable structured state?** No — it owns gate definitions.
4. **Fits existing lanes?** Yes — Q-series quality signal applied to the framework repo itself; measurement-vs-gating split respected (all checks here are deterministic blockers, no LLM judgment).
5. **Stackable?** Yes — the parity-lint pattern is the template for any future "one fact, one home" enforcement.

## Proposed change

### 1. Lint/format become gates (coordinated CI-inventory edit)

- Fix the standing reds in this PR: the `require()` import, and one `prettier --write` sweep (mechanical commit, separated for reviewability).
- New workflow `test-lint-format.yml` running `npm run lint`, `npm run format:check`, and `npm run typecheck`. This is the sanctioned coordinated expansion of the locked CI inventory; flagged for spec-validator to add the workflow to PROJECT_CONTEXT § Testing's list in its next pass.

### 2. API-surface parity check

`scripts/checks/api-tools-parity.mjs` (superseding the R7-scoped check, which it absorbs): for the server's full dispatch list, assert (a) every dispatch name has a registered handler, (b) every dispatch name has an `api-tools-v1.json` `properties` entry, (c) every schema entry is dispatched — three-way parity, no permissive-fallback advertisements. The fixes it forces land in the same PR: add the `trustList` schema entry; **delete** `getStackConventions` and `getOverlayField` from dispatch list and schema (they have never had handlers — removing an advertised-but-`NotImplemented` name pre-1.0 is cleanup, not a breaking change; re-introduction requires implementing them).

### 3. Prompt-surface parity lints (the deterministic answer to self-certification)

Two new maintainer lints, riding `test-house-rules.yml`'s invocation or a sibling step in the same workflow (no further workflow files):

- **`lint-artifact-parity`** — every run-dir artifact filename pattern mentioned in `skills/gan/SKILL.md` and `agents/*.md` resolves to a row in H4's `RUN_ARTIFACTS` catalog, and every catalog row is mentioned by at least one prompt or owned by `config-server`. Closes the H4-gap class in both directions.
- **`lint-splice-refs`** — every `mergedSplicePoints["<key>"]` literal in `agents/*.md` and `skills/gan/SKILL.md` names a key present in the overlay schema/C3 catalog. Closes the rename-breaks-prompts class.

(E11's tool-grant check is the third member of this family and ships there; together the three are the deterministic floor under any gate-strengthening PR. The residual LLM-behavioural risk remains covered by the release-gate dogfood protocol — BR-010's full answer is floor + protocol, stated honestly rather than pretending lints prove behaviour.)

### 4. Package-description staleness

`package.json` `description` "ClaudeAgents config MCP server (R1 skeleton)" is rewritten to describe the current server. The version-vocabulary mapping (package 0.x vs `[shipped-in-v1.0]` release markers) is recorded in the audit document; no code change.

## Schema additions

- `api-tools-v1.json` — add `trustList` (and its `required` entry); **remove** the two handler-less entries. Removal is a deliberate pre-1.0 exact-match cleanup, called out in the PR body; no version bump (the schema describes the live surface, and no released consumer exists).

## Acceptance criteria

1. **Green means green.** `npm run lint`, `npm run format:check`, and `npm run typecheck` all exit 0 on develop, and `test-lint-format.yml` runs them on every PR.
2. **Three-way parity.** `api-tools-parity.mjs` exits 0; seeded fixtures prove it fails on a dispatch-without-handler, a dispatch-without-schema-entry, and a schema-entry-without-dispatch. The old R7-scoped check is retired in the same PR (retirement row).
3. **`trustList` shaped; phantoms gone.** `trustList` has a schema entry; `getStackConventions`/`getOverlayField` appear in neither dispatch list nor schema, and `buildToolList()` output contains no permissive-fallback tool.
4. **Artifact parity bites.** `lint-artifact-parity` exits 0 on the repo; removing a catalog row or adding an uncatalogued filename to SKILL.md makes it fail (fixture-tested).
5. **Splice-ref parity bites.** `lint-splice-refs` exits 0; a fixture prompt naming a nonexistent splice key fails.
6. **Description retired.** `grep -c 'R1 skeleton' package.json` returns 0.

## Version bump: none required

Maintainer tooling, CI, and the two schema-inventory corrections; no server/CLI behaviour or bundled-prompt change reaches end users through `install.sh`'s version probe. If the PR ends up touching any installed surface beyond `api-tools-v1.json` housekeeping, it bumps per the standing discipline (the schema is bundled — the implementer makes the final call in the PR and states it).

## Dependencies

- **H4** (hard) — `lint-artifact-parity` reads the catalog.
- **E11** — the grant check completing the lint family; either order, cross-referenced.
- **R4 / D2 / Q6** (shipped) — the maintainer-lint and CI patterns extended here; cross-referenced, never edited.

## Bite-size note

One sprint, one PR, four commits: (1) red fixes (`require()`, prettier sweep); (2) CI workflow; (3) parity check + schema corrections; (4) the two prompt-surface lints + fixtures. Each commit independently green.

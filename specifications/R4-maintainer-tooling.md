# R4 — Maintainer tooling

## Problem

Some framework artifacts need validation in CI before they reach a user — schemas published to npm, stack files committed to the repo, capability fixtures that gate releases. The runtime API (R1) catches most issues at use time, but CI must also validate at *build* time. R4 is the maintainer-side toolset for this.

## Proposed change

A set of Node 18+ scripts under `scripts/` plus the GitHub Actions workflows that invoke them. Maintainer-only — never runs on a user's machine, and per the roadmap's discipline rule, error messages from these tools never appear in user-facing agent output.

### Scripts

```
scripts/
  lint-stacks/
    index.js           # validates stacks/*.md against schemas/stack-vN.json
                       # plus the cross-file invariants that fire at build time
  publish-schemas/
    index.js           # extracts JSON Schemas from spec annotations,
                       # writes schemas/<type>-vN.json deterministically
  capability-check/
    index.js           # E3's reference implementation
  pair-names/
    index.js           # standalone pairsWith consistency check
                       # (also runs inside R1 at runtime; this is the
                       # CI-time backstop)
```

Every script:

- Reads its inputs from the repo (no network).
- Writes its outputs to deterministic paths or stdout.
- Exits 0 on success, non-zero with a structured stderr report on failure.
- Is idempotent.

### `lint-stacks`

Validates `stacks/*.md`:

1. Parses the markdown body block.
2. Validates against `schemas/stack-vN.json` (where `N` matches the file's `schemaVersion`).
3. Runs the subset of F3's cross-file invariants that are decidable at build time without project context: `pairsWith.consistency` (against `src/modules/*/`), schema-version consistency.

Prints a summary: count of files checked, count of failures, structured error per failure.

### `publish-schemas`

The schemas in `schemas/<type>-vN.json` are authored as JSON Schema documents in the spec. `publish-schemas` re-extracts and writes them to ensure the on-disk copy matches the authoring source. CI runs this in dry-run mode and fails the PR if the on-disk schemas drift from the spec source.

This script exists so spec content remains the single source of truth even though the schemas are physical files for runtime use.

### `capability-check`

E3's reference implementation. Runs every fixture under `tests/fixtures/stacks/`, captures the evaluator output, normalises (strip timestamps, sort unordered arrays, drop tokens), diffs against the fixture's golden file. Fails on any non-empty diff.

### `pair-names`

Walks `src/modules/*/` and `stacks/*.md`. For each name appearing in both, checks `pairsWith` consistency. This is also enforced inside R1 at registration time; the CI-time script is a backstop for files that landed via direct edits.

### CI workflows

Per the roadmap's locked CI structure:

```
.github/workflows/
  shared-setup.yml       # reusable: checkout + Node 18 + npm ci + cache
  test-modules.yml       # runs `node --test tests/modules/**`
  test-capability.yml    # runs scripts/capability-check
  test-stack-lint.yml    # runs scripts/lint-stacks + scripts/pair-names
  test-schemas.yml       # runs scripts/publish-schemas in dry-run mode
```

Each category workflow `uses: ./.github/workflows/shared-setup.yml`. No category may pin its own Node version.

### What R4 does not do

- It does not run sprints (that's `/gan`).
- It does not modify user state (that's R3).
- It does not replace runtime validation (that's R1's `validateAll()`).
- Its error messages are for maintainers and CI logs, not for end users running `/gan`.

## Acceptance criteria

- `node scripts/lint-stacks` validates every `stacks/*.md` and exits with structured failure when any file violates the schema.
- `node scripts/publish-schemas --dry-run` exits non-zero if the on-disk schemas drift from the authoring source.
- `node scripts/capability-check` exits 0 with empty normalised diff for the bootstrap fixture set; exits non-zero with the diff on stderr otherwise.
- `node scripts/pair-names` exits 0 when every shared name has consistent `pairsWith` declarations; non-zero otherwise.
- The five CI workflows under `.github/workflows/` run on every push and PR; they all reuse `shared-setup.yml`.
- No CI workflow pins a Node version independently of `shared-setup.yml`.

## Dependencies

- F3 (schemas this tooling validates against)
- E3 (capability-check format)

## Bite-size note

Each script is one sprint. Recommend order: `lint-stacks` first (immediately useful, smallest), then `pair-names`, then `capability-check`, then `publish-schemas`. Workflow files land alongside the scripts they invoke.

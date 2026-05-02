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
  evaluator-pipeline-check/
    index.js           # E3's reference implementation
  pair-names/
    index.js           # standalone pairsWith consistency check
                       # (also runs inside R1 at runtime; this is the
                       # CI-time backstop)
  lint-no-stack-leak/
    index.js           # forbids ecosystem-specific identifiers outside
                       # their owning stack file (multi-stack guard rail)
    forbidden.json     # the per-stack identifier list
    allowlist.json     # explicit per-path exceptions
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
4. **Rejects scaffold-banner files.** Any stack file (at any tier) containing the literal line `# DRAFT — replace TODOs before committing.` fails with a `ScaffoldBannerPresent` error citing the path. This makes the `gan stacks new` (R3) scaffold's "you're not done yet" signal a CI hard error rather than a social problem. Removing the banner is the user's deliberate "I have replaced the TODOs" act.

Prints a summary: count of files checked, count of failures, structured error per failure.

### `publish-schemas`

The schemas in `schemas/<type>-vN.json` are authored as JSON Schema documents in the spec. `publish-schemas` validates the on-disk copy against the spec source and exits non-zero on drift; CI runs it in dry-run mode and fails the PR if the on-disk schemas have drifted from the source. The check is a drift-detection / consistency gate.

This script exists so spec content remains the single source of truth even though the schemas are physical files for runtime use.

The full **spec-extraction** path — programmatically extracting fenced JSON Schema blocks from the domain specs and writing them to `schemas/<type>-vN.json` — is a `TODO(future)` in the implementation: the v1 script does drift detection only, and the on-disk schemas are hand-authored alongside the spec text. Spec-extraction lights up when the domain specs adopt fenced JSON Schema annotations as a structured authoring format; until then, the maintainer hand-edits both the spec and the on-disk schema and `publish-schemas --dry-run` catches any divergence.

### `evaluator-pipeline-check`

E3's reference implementation. Runs every fixture under `tests/fixtures/stacks/`, captures the evaluator output, normalises (strip timestamps, sort unordered arrays, drop tokens), diffs against the fixture's golden file. Fails on any non-empty diff.

### `pair-names`

Walks `src/modules/*/` and `stacks/*.md`. For each name appearing in both, checks `pairsWith` consistency. This is also enforced inside R1 at registration time; the CI-time script is a backstop for files that landed via direct edits.

### `lint-no-stack-leak`

Implements the multi-stack guard rail catalogued in the roadmap's Cross-cutting principles. While the active plan ships only one real ecosystem stack (`web-node`), this script ensures the framework's core code never assumes web-node specifics.

**What it checks.** Greps the repository for ecosystem-specific identifiers and fails the build if any appear outside their owning stack file or an explicitly-allowlisted path. The scan covers framework code (`src/config-server/`, `src/agents/`) **and agent prompt files** (`agents/*.md`, the orchestrator `skills/gan/SKILL.md`). E1 promises agent prompts contain zero references to `kt`, `kts`, `gradle`, `npm audit`, etc.; this lint enforces the promise rather than relying on review discipline. The forbidden list lives in `scripts/lint-no-stack-leak/forbidden.json`:

```json
{
  "web-node": [
    "package.json",
    "package-lock.json",
    "node_modules",
    "npm",
    "pnpm",
    "yarn",
    ".nvmrc",
    "tsconfig.json"
  ]
}
```

**Where they're allowed.**

- `stacks/web-node.md` — the owning stack file.
- `tests/fixtures/stacks/js-ts-minimal/` — the bootstrap fixture for that stack.
- `tests/fixtures/stacks/polyglot-webnode-synthetic/` — the cross-contamination fixture.
- `package.json`, `package-lock.json` at the repo root — the framework itself is npm-distributed (per F2 / R1) and these files are unavoidable.
- Maintainer-tooling files under `scripts/`, `.github/workflows/`, `install.sh`, R2's installer source, and the `@claudeagents/config-server` `package.json` — these legitimately invoke npm because the framework is distributed via Node.
- Anything explicitly listed in `scripts/lint-no-stack-leak/allowlist.json`. Adding to the allowlist requires a reviewer-visible diff and a one-line justification in the JSON.

**What it does not check.**

- It does not validate semantic content. A reference to `package.json` inside a code comment that *describes* what the framework does (e.g. discussing detection rules) is a hit, not a pass; rephrase or allowlist the file. The script is intentionally noisy: false positives are a feature when the alternative is a Node assumption smuggled in unnoticed.
- It does not extend to user projects. The script runs at framework-build time, not against `/gan` consumer repos.

**When the deferred stacks are reactivated.** Each new ecosystem (Android, KMP, iOS Swift, etc.) adds its own `forbidden` list to `forbidden.json` and its own owning-file allowlist. The principle scales: every real stack the framework supports gets an enforced isolation boundary.

**Transitional allowlist for the pre-E1 mid-state.** R4 lands in Phase 2 (per the roadmap), but the existing agent prompts under `agents/*.md` and the existing `skills/gan/SKILL.md` carry stack-specific tokens — those tokens are exactly what E1 retires in Phase 3. To prevent R4's CI from failing every Phase 2 commit on the feature branch, the allowlist ships with explicit transitional entries:

```json
{
  "transitional": {
    "agents/gan-evaluator.md":           "remove when E1 lands",
    "agents/gan-contract-proposer.md":   "remove when E1 lands",
    "agents/gan-contract-reviewer.md":   "remove when E1 lands",
    "agents/gan-generator.md":           "remove when E1 lands",
    "agents/gan-planner.md":             "remove when E1 lands",
    "skills/gan/SKILL.md":               "remove when E1 lands"
  }
}
```

These entries grant temporary immunity to the named files. The E1 retirement PR removes both the entries and the underlying file content in the same commit set — once the prompts are rewritten and the stack tokens lifted into `stacks/*.md`, the transitional allowlist is empty and gets deleted. Surviving transitional entries after E1 are themselves a CI failure (a separate pre-merge check verifies the `transitional` block is empty post-E1).

**The post-E1 check is internal-consistency, not temporal.** The pre-merge check does not know "is E1 merged?" — there is no state machine tracking phase progress. It runs every time and verifies a single mechanical predicate: each path in the `transitional` block must still contain at least one of `forbidden.json`'s tokens. Once an E1-target file is rewritten and clean, its allowlist entry has nothing to grant immunity to — it's an empty exception, and the check fails until the entry is removed. The CI maintainer implementing this script writes a pure file-scan, not a phase tracker.

**Output.** Hits print as `<file>:<line> <identifier> (owned by <stack>)` followed by either "no allowlist match" or, on intentional failure, the allowlist entry that should have applied but did not.

### `lint-error-text`

Enforces the roadmap's user-facing error-text discipline rule: error messages and remediation hints emitted by the framework must not reference maintainer-only tooling (`npm`, `Node`, `tsc`, `package.json` as a fix instruction, etc.). Today this rule is policy; without a CI check, a future contributor adding text like *"run `npm run repair` to fix"* slips through.

**What it checks.** Greps `src/config-server/` and `src/agents/` for string literals that contain the same forbidden tokens `lint-no-stack-leak` defines, but only when the literal appears inside structures the framework uses for user-facing output: error-object `message` and `remediation` fields, agent-prompt error templates, log-line strings tagged as user-visible. The script's heuristic looks for the literal patterns that emit user text (`message:`, `remediation:`, `console.error(`, `userOutput(`); allowlists the same paths `lint-no-stack-leak` allowlists.

**What it does not check.** Internal log lines (those tagged maintainer-only or routed to `.gan-state/runs/<run-id>/logs/`) are exempt. The bar is "would a `/gan` user see this string?" — anything visible to a user is in scope; anything for maintainer / debugging eyes only is not. Heuristic is intentionally noisy: false positives go in an allowlist with a justification.

The script lives at `scripts/lint-error-text/index.js`; CI workflow `test-error-text.yml` invokes it.

### CI workflows

Per the roadmap's locked CI structure:

```
.github/workflows/
  shared-setup.yml       # reusable: checkout + Node 18 + npm ci + cache
  test-modules.yml       # runs `node --test tests/modules/**`
  test-evaluator-pipeline.yml    # runs scripts/evaluator-pipeline-check
  test-stack-lint.yml    # runs scripts/lint-stacks + scripts/pair-names
  test-schemas.yml       # runs scripts/publish-schemas in dry-run mode
  test-no-stack-leak.yml # runs scripts/lint-no-stack-leak
  test-error-text.yml    # runs scripts/lint-error-text
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
- `node scripts/evaluator-pipeline-check` exits 0 with empty normalised diff for the bootstrap fixture set; exits non-zero with the diff on stderr otherwise.
- `node scripts/pair-names` exits 0 when every shared name has consistent `pairsWith` declarations; non-zero otherwise.
- `node scripts/lint-no-stack-leak` exits 0 when every forbidden identifier appears only in its owning stack file or an allowlisted path; non-zero with a structured per-hit report otherwise. Adding a new allowlist entry requires a reviewable diff to `scripts/lint-no-stack-leak/allowlist.json` with a justification field.
- `node scripts/lint-error-text` exits 0 when no forbidden token appears in user-facing error or remediation text; non-zero with structured per-hit report otherwise.
- The seven CI workflows under `.github/workflows/` run on every push and PR; they all reuse `shared-setup.yml`.
- No CI workflow pins a Node version independently of `shared-setup.yml`.

## Dependencies

- F3 (schemas this tooling validates against)

E3 owns the capability-check fixture/golden/normalisation format; R4's `scripts/evaluator-pipeline-check` implementation depends on E3 at implementation time, but the R4 spec catalogues the script's *existence* without committing to format details.

## Bite-size note

Each script is one sprint. Recommend order: `lint-stacks` first (immediately useful, smallest), then `pair-names`, then `evaluator-pipeline-check`, then `publish-schemas`. Workflow files land alongside the scripts they invoke.

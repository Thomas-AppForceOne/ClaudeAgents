# 06 — Extract built-in stacks

## Problem

With the schema (04) and dispatch (05) in place, the existing stack-specific logic still lives in agent prompts. Until it moves, the new plugin system is unused and duplicates the old hardcoded paths.

## Proposed change

Extract each of the current hardcoded stacks into its own file under `stacks/`, with no behavior change:

- `stacks/web-node.md` — captures the existing JS/TS logic (`npm audit`, current secrets glob subset, TLS/CORS/session security surfaces, `node`/`npm start`-style run command). **Detection must use the composite form** defined in spec 04: `package.json` alone is insufficient; a lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`) or a `start`/`dev`/`build` script in `package.json` is also required. This prevents spurious activation on Node-packaged repositories that are not web-node applications — including the ClaudeAgents framework repo itself (which ships `package.json` only to support `npm link` for its runtime-utility modules).
- `stacks/python.md` — `pip-audit` / `safety`, Python surfaces.
- `stacks/rust.md` — `cargo audit`.
- `stacks/go.md` — `govulncheck`.
- `stacks/ruby.md` — `bundle audit`.
- `stacks/kotlin.md` — absorbs the Phase 1 Kotlin additions from spec 01: `.kt`, `.kts`, `.gradle.kts` in `secretsGlob`; detection on any Kotlin source file.
- `stacks/gradle.md` — absorbs the Phase 1 Gradle branch from spec 02: detection on `settings.gradle` / `settings.gradle.kts` / `build.gradle*`; `auditCmd` with the Gradle branch logic including the "no audit tool configured" `blockingConcern` fallback.
- `stacks/generic.md` — conservative fallback (spec 05).

Once extracted, the agent prompts drop their hardcoded lists and rely on the active stack set. Specs 01 and 02 are retired by this extraction — their behavior is preserved inside the stack files, not in agent prompts. Spec 03's hardcoded env-var catalog is likewise retired: each cache-using stack (`stacks/gradle.md`, `stacks/web-node.md`, any future tool-cache-bearing stack) declares its own `cacheEnv` per spec 04, and the skill orchestrator drops its temporary catalog.

**The contract-proposer's hardcoded security checklist is also retired.** The proposer today enumerates ~10 generic security criteria directly in its prompt. After this extraction, all security criteria originate from active stacks' `securitySurfaces` via the template-instantiation protocol defined in spec 04. The proposer retains its sprint-shape logic (threshold selection, rationale writing) but owns zero stack-specific content.

## Parity test harness

"Identical behavior before and after" is measured against a fixed set of fixture repos under `tests/fixtures/stacks/`:

- `tests/fixtures/stacks/js-ts-minimal/` — a small JS/TS project exercising `npm audit` and the web security surfaces.
- `tests/fixtures/stacks/python-minimal/` — pyproject + one module.
- `tests/fixtures/stacks/polyglot-android-node/` — proves cross-contamination is prevented (the cross-check fixture from spec 05).
- `tests/fixtures/stacks/node-packaged-non-web/` — a repo with only a `package.json` (no lockfile, no `start`/`dev`/`build` script), mimicking the ClaudeAgents framework's own shape. Asserts that the tightened web-node detection (spec 04) does **not** activate `stacks/web-node.md` and the repo falls through to `stacks/generic.md`.
- one fixture per extracted stack, minimally configured to trigger its detection.

Parity is measured by running `/gan` (or the evaluator in isolation) on each fixture against the `main` branch **before** and **after** this change, then diffing the resulting feedback JSON. The diff is normalised to remove non-semantic noise before comparison:

- strip timestamps, durations, PIDs, and worktree paths
- sort array fields with no declared order (e.g. `blockingConcerns` by `id`)
- drop token-usage counts and model identifiers

The normalised diff must be empty. A harness script `scripts/parity-check.sh` runs the before/after comparison in CI and fails the PR on any non-empty diff.

## Acceptance criteria

- Running `/gan` on an existing JS/TS project produces identical evaluator behavior before and after this change (diff the feedback JSON).
- Running `/gan` on a Python project identical before and after.
- No agent prompt still contains hardcoded file extensions, audit commands, or stack-specific security criteria. Concretely: `gan-evaluator.md` must contain zero references to `kt`, `kts`, `gradle`, `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, or any other tool-specific token. The same applies to every other agent prompt.
- `gan-contract-proposer.md` (or whichever agent today owns the security checklist) contains zero hardcoded security criteria. Every security criterion in a generated contract traces to a `securitySurfaces` entry in an active stack.
- `scripts/parity-check.sh` produces an empty normalised diff for every fixture in `tests/fixtures/stacks/`.
- Regression tests (if any exist in the repo) continue to pass.

## Dependencies

- 04, 05

## Value / effort

- **Value**: medium on its own, but this is what retires the old code path and lets Phase 3 add new stacks cleanly. Without it, every new stack has to be added to both the agent prompt and a new stack file.
- **Effort**: medium. The refactor is mechanical but touches every agent. Doing it in one PR with the parity tests above is safer than incremental moves.

# 06 — Extract built-in stacks

## Problem

With the schema (04) and dispatch (05) in place, the existing stack-specific logic still lives in agent prompts. Until it moves, the new plugin system is unused and duplicates the old hardcoded paths.

## Proposed change

Extract each of the current hardcoded stacks into its own file under `stacks/`, with no behavior change:

- `stacks/web-node.md` — captures the existing JS/TS logic (`npm audit`, current secrets glob subset, TLS/CORS/session security surfaces, `node`/`npm start`-style run command).
- `stacks/python.md` — `pip-audit` / `safety`, Python surfaces.
- `stacks/rust.md` — `cargo audit`.
- `stacks/go.md` — `govulncheck`.
- `stacks/ruby.md` — `bundle audit`.
- `stacks/kotlin.md` — absorbs the Phase 1 Kotlin additions from spec 01: `.kt`, `.kts`, `.gradle.kts` in `secretsGlob`; detection on any Kotlin source file.
- `stacks/gradle.md` — absorbs the Phase 1 Gradle branch from spec 02: detection on `settings.gradle` / `settings.gradle.kts` / `build.gradle*`; `auditCmd` with the Gradle branch logic including the "no audit tool configured" `blockingConcern` fallback.
- `stacks/generic.md` — conservative fallback (spec 05).

Once extracted, the agent prompts drop their hardcoded lists and rely on the active stack set. Specs 01 and 02 are retired by this extraction — their behavior is preserved inside the stack files, not in agent prompts.

## Acceptance criteria

- Running `/gan` on an existing JS/TS project produces identical evaluator behavior before and after this change (diff the feedback JSON).
- Running `/gan` on a Python project identical before and after.
- No agent prompt still contains hardcoded file extensions, audit commands, or stack-specific security criteria. Concretely: `gan-evaluator.md` must contain zero references to `kt`, `kts`, `gradle`, `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, or any other tool-specific token. The same applies to every other agent prompt.
- Regression tests (if any exist in the repo) continue to pass.

## Dependencies

- 04, 05

## Value / effort

- **Value**: medium on its own, but this is what retires the old code path and lets Phase 3 add new stacks cleanly. Without it, every new stack has to be added to both the agent prompt and a new stack file.
- **Effort**: medium. The refactor is mechanical but touches every agent. Doing it in one PR with the parity tests above is safer than incremental moves.

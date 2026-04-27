# R4 — Maintainer tooling

**Status:** Stub. Drafted in Phase 2.

## Purpose

CI-side and contributor-side tools that operate on framework artifacts directly (not through the API). These run on maintainer machines and in ClaudeAgents' own CI; they never run on a user's machine.

## Anticipated content

- **Stack-file lint script.** Validates every `stacks/*.md` against the JSON Schema declared per F3. Fails CI on any violation. Catches hand-edits that haven't passed through the API yet.
- **Schema publisher.** Generates and publishes the JSON Schema documents from their authoring source. Ensures docs and lint are in sync.
- **Capability-check runner.** Executes E3's golden-file harness against fixtures. Fails CI on any normalised diff.
- **Pair-name consistency checker.** Verifies `pairsWith` invariants across modules and stacks at CI time, complementing the API's runtime enforcement (catches files that bypassed the API).
- **CI workflow files.** Per the roadmap's CI structure: `shared-setup.yml`, `test-modules.yml`, `test-capability.yml`, optionally `test-stack-lint.yml`.

## Dependencies

- F3 (schema authority — lint sources its rules from here)
- E3 (capability-check format — for the runner)

## Bite-size note

Each tool is independently sprintable: lint script first (smallest, immediately useful), then schema publisher, then CI workflow scaffolding, then capability-check runner.

# E2 — Built-in stack extraction

## Problem

With the schema (C1) and dispatch (C2) in place, the existing stack-specific logic still lives in agent prompts. Until it moves, the new plugin system is unused and duplicates the old hardcoded paths.

## Proposed change

Extract each of the current hardcoded stacks into its own file under `stacks/`:

- `stacks/web-node.md` — captures the existing JS/TS logic (`npm audit`, current secrets glob subset, TLS/CORS/session security surfaces, `node`/`npm start`-style run command). **Detection must use the composite form** defined in spec C1: `package.json` alone is insufficient; a lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`) or a `start`/`dev`/`build` script in `package.json` is also required. This prevents spurious activation on Node-packaged repositories that are not web-node applications — including the ClaudeAgents framework repo itself (which ships `package.json` only to support `npm link` for its runtime-utility modules).
- `stacks/python.md` — `pip-audit` / `safety`, Python surfaces.
- `stacks/rust.md` — `cargo audit`.
- `stacks/go.md` — `govulncheck`.
- `stacks/ruby.md` — `bundle audit`.
- `stacks/kotlin.md` — `.kt`, `.kts`, `.gradle.kts` in `secretsGlob`; detection on any Kotlin source file.
- `stacks/gradle.md` — detection on `settings.gradle` / `settings.gradle.kts` / `build.gradle*`; `auditCmd` with the Gradle branch logic including the "no audit tool configured" `blockingConcern` fallback.
- `stacks/generic.md` — conservative fallback (spec C2).

Once extracted, the agent prompts drop their hardcoded lists and rely on the active stack set. Each cache-using stack (`stacks/gradle.md`, `stacks/web-node.md`, any future tool-cache-bearing stack) declares its own `cacheEnv` per spec C1; there is no centralized env-var catalog in the orchestrator.

**The contract-proposer's hardcoded security checklist is also retired.** The proposer today enumerates ~10 generic security criteria directly in its prompt. After this extraction, all security criteria originate from active stacks' `securitySurfaces` via the template-instantiation protocol defined in spec C1. The proposer retains its sprint-shape logic (threshold selection, rationale writing) but owns zero stack-specific content.

Correctness of the extraction is gated by the evaluator-pipeline harness (E3) — a separate spec covering the fixture layout, evaluator-plan goldens, and normalisation rules.

## Acceptance criteria

- Running `/gan` on each fixture in `tests/fixtures/stacks/` produces a feedback JSON that matches the fixture's golden file (after normalisation).
- No agent prompt still contains hardcoded file extensions, audit commands, or stack-specific security criteria. Concretely: `gan-evaluator.md` must contain zero references to `kt`, `kts`, `gradle`, `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, or any other tool-specific token. The same applies to every other agent prompt.
- `gan-contract-proposer.md` (or whichever agent today owns the security checklist) contains zero hardcoded security criteria. Every security criterion in a generated contract traces to a `securitySurfaces` entry in an active stack.
- `scripts/evaluator-pipeline-check` (E3's reference implementation) produces an empty normalised diff for every fixture in `tests/fixtures/stacks/` when run in CI.
- The E2 PR's body includes an **extraction audit** listing every stack-specific concept lifted from the old prompts into `stacks/<name>.md` files, plus an explicit "retired, not lifted" subsection enumerating anything dropped (e.g. an audit-command branch deemed obsolete). Concepts that are neither lifted nor explicitly retired block the PR — the discipline is "every old token has a documented destination."

## Retirement coordination with E1

E2's stack-extraction work and E1's agent-rewrite work are tightly coupled: the rewritten prompts (E1) need the stack files (E2) to exist, and the stack files (E2) are sourced from the old prompts that E1 retires.

Per the [roadmap's resolution of spec-completion order vs commit order](roadmap.md#phase-3--agent-integration), Phase 3 is a single coordinated PR with two ordering layers:

- **Spec-completion order: E1 → E3 → E2.** E1's contract is what E2 and E3 consume; E1 must be authoritatively complete first. The roadmap's stated implementation order describes this layer.
- **Commit order inside the PR: E2's content-lifting commits before E1's prompt-rewrite-in-place commits.** The old prompts are the source material for E2's stack-extraction work; once E1's commits rewrite `agents/*.md`, the source is gone and any concept not yet lifted is unrecoverable except from git history.

The two orderings compose: E1 specifies *what* the rewrite produces; E2 commits the new stack content while the source still exists; E1 commits the rewrite-in-place that finally retires the old content. A reviewer looking at the merged PR sees stacks added before agents change — exactly what extraction-then-replace should look like.

E2 does not delete any files itself — it produces new files (`stacks/*.md`) and prepares the content E1's prompt rewrites will reference. The actual `M` rewrite-in-place on agent prompts happens in E1 per the [roadmap's Retirement table](roadmap.md#retirement-table).

## Dependencies

- C1, C2, R1 (writes happen via the API, not direct file edits)

E3 gates the refactor in implementation; E2 itself is authorable independently of E3.

## Bite-size note

E2 is larger than its "Value / effort" rating below suggests — eight stack files plus a contract-proposer retirement plus harness coordination. Recommended sprint slicing, with each slice gated by E3's harness:

1. `stacks/web-node.md` (most-tested ecosystem; surfaces detection-composite issues first).
2. `stacks/python.md`, `stacks/rust.md`, `stacks/go.md`, `stacks/ruby.md` (one slice each; small and similar).
3. `stacks/kotlin.md` + `stacks/gradle.md` (one slice; they pair via detection-union).
4. `stacks/generic.md` (the fallback; lands last because earlier slices may surface fields it needs).
5. Contract-proposer hardcoded-checklist retirement.

Alternative: collapse E2 into the same coordinated PR as E1 (the agent rewrite). They are inherently coupled — the rewrite cannot complete until stack files exist for the agents to read. Doing both in one PR with per-slice commits keeps review tractable while preserving end-to-end correctness gating.

## Value / effort

- **Value**: medium-high. Retires the old hardcoded code path. Also unblocks any future real-ecosystem stack (the Android, KMP, and iOS Swift specs in [`specifications/deferred/`](deferred/README.md), or any new ecosystem authored later) — once stack files exist as data rather than code, adding one is a file drop, not a refactor.
- **Effort**: medium-large. Mechanical per stack, but eight stacks + the proposer retirement is more sprint slices than its "medium" sibling specs.

# E2 — Built-in stack extraction

## Problem

With the schema (C1) and dispatch (C2) in place, the existing stack-specific logic still lives in agent prompts. Until it moves, the new plugin system is unused and duplicates the old hardcoded paths.

## Proposed change

Per the roadmap's "single real stack" principle (see [Cross-cutting principles](roadmap.md#cross-cutting-principles) and ["How to read the spec set"](roadmap.md#how-to-read-the-spec-set)), the active plan ships exactly **one real ecosystem stack** plus the generic fallback:

- `stacks/web-node.md` — captures the existing JS/TS logic (`npm audit`, current secrets glob subset, TLS/CORS/session security surfaces, `node`/`npm start`-style run command). **Detection must use the composite form** defined in spec C1: `package.json` alone is insufficient; a lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`) or a `start`/`dev`/`build` script in `package.json` is also required. This prevents spurious activation on Node-packaged repositories that are not web-node applications — including the ClaudeAgents framework repo itself (which ships `package.json` only to support `npm link` for its runtime-utility modules).
- `stacks/generic.md` — conservative fallback (spec C2).

The synthetic fixture-only stack (`tests/fixtures/stacks/synthetic-second/.claude/gan/stacks/synthetic-second.md`) is created by R1 per the multi-stack guard rail principle — it is **not** authored by E2 and is **not** a shipped real stack. E2 references it only to confirm its content remains consistent with C1's schema after extraction.

**Stack-specific content currently in the old prompts but NOT shipped as separate stacks** (Python, Rust, Go, Ruby, Kotlin, Gradle, and the legacy stack-specific tokens in `gan-evaluator.md` like `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, `.kt`/`.kts`/`.gradle.kts` extensions, Gradle audit-fallback logic, etc.) are content-mining sources for the **extraction audit**, not extraction targets. Each such concept must end up in one of three buckets:

1. **Lifted into `stacks/web-node.md` or `stacks/generic.md`** if it generalises to a shipped stack (e.g. a security-surface category that applies broadly).
2. **Lifted into the synthetic-second fixture** if it usefully exercises the C1 schema (e.g. a detection composite, a `cacheEnv` shape) — note this is a fixture content addition, coordinated with R1, not a new shipped stack.
3. **Explicitly retired** in the E2 PR's extraction audit subsection, with a one-line justification.

Real-ecosystem stacks for Android (Kotlin client + Gradle), Kotlin Multiplatform, and iOS Swift are out of scope for the active plan. They live as authored-but-deferred specs in [`specifications/deferred/`](deferred/README.md) and are reactivated only per the criteria documented there. Any other ecosystem (Python, Rust, Go, Ruby) currently has no shipped real stack; users wanting one author it themselves at the project tier (per C5) or contribute it back upstream as a single canonical stack-file PR (per the roadmap's [single-canonical principle](roadmap.md#cross-cutting-principles)).

Once extracted, the agent prompts drop their hardcoded stack-specific tokens and rely on the active stack set. `stacks/web-node.md` declares its own `cacheEnv` per spec C1 if it has tool caches to surface; `stacks/generic.md` does not. There is no centralized env-var catalog in the orchestrator.

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

E2 is small under the active plan — two shipped stack files plus the contract-proposer retirement plus the extraction audit. Recommended sprint slicing, with each slice gated by E3's harness:

1. `stacks/web-node.md` (most-tested ecosystem; surfaces detection-composite issues first).
2. `stacks/generic.md` (the fallback; lands second because the web-node slice may surface fields generic needs).
3. Contract-proposer hardcoded-checklist retirement.
4. Extraction audit (the PR-body subsection enumerating every old-prompt concept and its destination — lifted into web-node, lifted into the synthetic-second fixture, or explicitly retired).

Per the roadmap's [Phase 3](roadmap.md#phase-3--agent-integration) coordination rules, E2 ships in the same PR as E1 (the agent rewrite). The two are inherently coupled — the rewrite cannot complete until stack files exist for the agents to read; the stack files are sourced from the prompts E1 retires. Per-slice commits inside the coordinated PR keep review tractable while preserving end-to-end correctness gating.

## Value / effort

- **Value**: medium-high. Retires the old hardcoded code path. Also unblocks any future real-ecosystem stack (the Android, KMP, and iOS Swift specs in [`specifications/deferred/`](deferred/README.md), or any new ecosystem authored later) — once stack files exist as data rather than code, adding one is a file drop, not a refactor.
- **Effort**: medium. Two shipped stack files plus the proposer retirement plus a careful extraction audit. Smaller than earlier drafts of this spec implied; the audit subsection (every old-prompt concept lifted, retained-as-fixture-content, or explicitly retired) is the discipline-keeping work.

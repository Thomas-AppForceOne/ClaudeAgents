# ClaudeAgents — Roadmap

## End state

ClaudeAgents is a framework for AI-driven software development workflows — sprint planning, code generation, review, verification — that works on any technology stack. When this redesign is fully shipped, a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, and more) installs ClaudeAgents once, restarts Claude Code once, and `/gan` operates on their project. Adding support for a new ecosystem is a file drop, not a code change. Node is required once at install time (the framework is distributed via npm); after install, daily workflow on a non-Node ecosystem never touches Node.

The architectural backbone is a **Configuration API** that hides storage, validation, and merging behind a small set of named functions. Agents call those functions; they do not parse files, do not know schemas, and do not enumerate tiers. Stack files declare per-ecosystem behavior; overlays apply per-user and per-project customization through a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config, durable state, and cache zones with non-overlapping lifecycles, so persistent module state cannot collide with per-run orchestration data. Configuration files are hand-editable; the API validates on read and surfaces structured errors when something is wrong.

The plan is now **release-driven**. Phases 0–4 (foundations, configuration, reference implementation, agent integration, modules) have shipped and provide the architectural spine. The active plan is structured as **v1.0 → v1.1 → v1.2 → v2.0 → beyond**: each release ships a coherent slice that gives real-world signal before the next slice is designed in detail. Specs that depend on usage data to be authored well are deliberately deferred until that data exists.

## How to read the spec set

Specs are organised by **phase code**:

- **F** — foundation
- **C** — configuration domains
- **R** — reference implementation
- **E** — agent integration
- **M** — modules
- **U** — user-facing extensibility
- **O** — observability and operations
- **A** — agent safety
- **T** — telemetry
- **V** — LLM-verdict verification
- **B** — benchmarks
- **Q** — quality signal
- **S** — stack content (reserved for real-ecosystem stack files; deferred S-series in [`specifications/deferred/`](deferred/README.md))

Filenames carry the phase code. The phase code groups specs by concern; release milestones below describe the order they land in.

The active plan ships exactly one real stack (`web-node`) plus a fixture-only synthetic stack used as a multi-stack guard rail (see "Cross-cutting principles" below). Authored-but-deferred S-series specs (Android, KMP, iOS Swift) live under [`specifications/deferred/`](deferred/README.md) until reactivation criteria are met.

## Shipped phases

The architectural spine has landed across five completed phases. Each phase closed with a revision-break audit before the next began; the discipline pattern carries forward to v1.0+.

### Phase 0 — Foundations
- [F1-filesystem-layout.md](F1-filesystem-layout.md) — Three project zones (`.claude/gan/`, `.gan-state/`, `.gan-cache/`) with single-owner lifecycles. Retires the old `.gan/` directory.
- [F2-config-api-contract.md](F2-config-api-contract.md) — Black-box function surface, MCP binding, validation timing, install/restart story, error model.
- [F3-schema-authority.md](F3-schema-authority.md) — JSON Schema location, `schemaVersion` semantics, lint integration.
- [F4-threat-model-and-trust.md](F4-threat-model-and-trust.md) — Threat model, trust-cache contract, `UntrustedOverlay` error, `GAN_TRUST` modes, `--no-project-commands` flag, path-escape rules.

### Phase 1 — Configuration domains
- [C1-stack-plugin-schema.md](C1-stack-plugin-schema.md) — Stack file schema, detection composites, parse contract.
- [C2-stack-detection-and-dispatch.md](C2-stack-detection-and-dispatch.md) — Dispatch algorithm, scope filtering, generic fallback.
- [C3-overlay-schema.md](C3-overlay-schema.md) — Overlay splice points, defaults, `discardInherited`.
- [C4-three-tier-cascade.md](C4-three-tier-cascade.md) — default → user → project merge per splice point.
- [C5-stack-file-resolution.md](C5-stack-file-resolution.md) — project → user → repo lookup for stack files.

### Phase 2 — Reference implementation
- [R1-config-mcp-server.md](R1-config-mcp-server.md) — Node 18+ MCP server implementing F2.
- [R2-installer.md](R2-installer.md) — `install.sh`, MCP registration, zone preparation.
- [R3-cli-wrapper.md](R3-cli-wrapper.md) — `gan validate`, `gan config`, `gan stacks`.
- [R4-maintainer-tooling.md](R4-maintainer-tooling.md) — Lint script, schema publisher, evaluator-pipeline-check runner, pair-names check, CI workflows.
- [R5-trust-cache-impl.md](R5-trust-cache-impl.md) — Reference implementation of F4: hash function, cache I/O, `validateAll()` integration, `getTrustState`/`trustApprove` MCP tools, `--no-project-commands` runtime flag routing, `PathEscape` invariant.

### Phase 3 — Agent integration (initial)
- [E1-agent-integration.md](E1-agent-integration.md) — Orchestrator and agent prompt rewrites consuming the Configuration API.
- [E2-builtin-stack-extraction.md](E2-builtin-stack-extraction.md) — Extracted `web-node` and `generic` into stack files.
- [E3-evaluator-pipeline-harness.md](E3-evaluator-pipeline-harness.md) — Deterministic-core fixture harness with hand-authored evaluator-plan goldens.

### Phase 4 — Modules
- [M1-modules-architecture.md](M1-modules-architecture.md) — Module manifest, lifecycle, `pairsWith` enforcement, filesystem zone boundaries, distribution.
- [M2-docker-module.md](M2-docker-module.md) — PortRegistry, PortDiscovery, ContainerHealth, PortValidator, ContainerNaming.
- [M3-module-surface-alignment.md](M3-module-surface-alignment.md) — Per-key state-file layout, `key` parameter on every module-state API function, `stateKeys` allowlist enforcement, `duplicatePolicy` on `appendToModuleState`, keyed-lookup `removeFromModuleState`.

### Revision-break record

Each shipped phase closed with an audit. Their resolutions remain load-bearing for downstream specs and are preserved here.

- **Post-R contract audit (closed).** F2/F3/F4/R5/C1–C5 re-audited against R1–R5 implementation. F2's function surface and structured-error model refined. F4/R5 operational readiness exercised against three real PRs of varying shape.
- **Post-E1 audit + O2 first prescriptive revision (closed).** O1's startup-log shape confirmed against E1 coordinator output. O2 reconceived from descriptive to prescriptive under F1 zones and E1's snapshot model. U3 consumption pattern validated end-to-end.
- **Post-M module surface audit (closed 2026-05-07).** Eight items resolved:
  - **F2** closed with a minor edit clarifying `registerModule` is a runtime probe; `manifest` argument is advisory; production registration cache is built lazily by `getRegisteredModules()`.
  - **F3** closed with no edit; both schemas already cover what M2 declares and uses.
  - **R1** closed with no edit; misleading registration-timing prose lived in M1 and was fixed there.
  - **M1** closed with edits to the registration-time bullet, the `stateKeys`/`configKey` paragraph, and the persistence bullet.
  - **C4** module configs at `.claude/gan/modules/<name>.yaml` are project-tier-only and do not participate in the three-tier cascade.
  - **M1/F2 (stateKeys)** — `stateKeys` is the authoritative allowlist of named state blobs the module owns. Each declared key persists to its own file at `.gan-state/modules/<name>/<key>.json`. Writes to undeclared keys rejected with structured error.
  - **F2/M1 (duplicatePolicy)** — F2 spec wins: `appendToModuleState(moduleName, key, entry, duplicatePolicy="error")` is correct.
  - **F2/M1 (removeFromModuleState)** — F2 spec wins: removal is by entry key (keyed lookup), not by deep-equal value match.
  - **Implementation alignment** authored separately as M3 (Phase 4 alignment).

## v1.0 — first release

**Goal:** ship a usable product to early users so design assumptions get tested against real prompts, real codebases, and real failures. Eight items, five carryover from the original phase plan, three net-new specs.

The shape of the v1.0 user experience: a developer installs ClaudeAgents, edits `.claude/gan/project.md` to declare their project's quirks, runs `/gan` with a prompt, gets bounded clarifying questions on genuine ambiguities, sees a startup log telling them which stacks activated, gets a sprint plan/contract/generation/evaluation cycle that won't loop forever, can `--recover` if interrupted, and can read a structured trace afterward to understand what happened.

### Carryover

- **Full [O1-resolution-observability.md](O1-resolution-observability.md).** R1 already shipped the minimum-viable startup-log surface in Phase 2. v1.0 adds `gan config print`, `--print-config` JSON, and discard-array reporting. Without these, users can't debug their own setups without filing issues.
- **[O2-recovery.md](O2-recovery.md).** Per-run state archive, `--recover`, `--list-recoverable`. Spec already had its prescriptive authoring at the post-E1 break.
- **[U1-project-overlay-ux.md](U1-project-overlay-ux.md).** Hand-editable `.claude/gan/project.md`, validation errors, examples, mental-model guide. Project overlays are the reason the configuration API exists; v1.0 without them is a tech demo.
- **[U2-user-overlay-ux.md](U2-user-overlay-ux.md).** `~/.claude/gan/config.md`, cross-project preferences, auto-memory integration. Ships naturally with U1 — same surface, marginal cost.
- **[U3-additional-context-splice.md](U3-additional-context-splice.md).** `additionalContext` splice points for planner/proposer.

### New for v1.0

- **A1 — Loop & thrash detection.** Hard ceiling on attempts per sprint; edit-fingerprint history; halt with `LoopDetected` on oscillation. Single biggest safety gap in the current architecture; non-negotiable for v1.0. Doesn't need real-world data to design.
- **T1 — Structured run trace.** Every LLM call + tool call written under `.gan-state/runs/<id>/trace/` with prompt hash, response hash, token counts, cache-hit flag, latency, tool-call sequence. Schema at `schemas/run-trace-v1.json` per F3 conventions. T1 is the substrate every later phase reads from — landing it in v1.0 makes T2/V/B/Q materially cheaper to build later.
- **E5 — Spec clarification phase.** New `gan-clarifier` agent role between user prompt ingestion and the planner. Identifies ambiguities and gaps, asks bounded blocker questions, declares assumptions for non-blocking gaps. Without this, v1.0 dogfooding signal is dominated by "the planner misread me" complaints, which mask everything else.

  **Minimal first cut for v1.0:** one round, ≤ 3 blockers, no auto-promotion to project context, no confidence scoring. The clarifier reads `additionalContext` (U3) first and asks only about what's still ambiguous. Iteration on round budget, confidence model, and persistence happens in v1.1 once usage shows which ambiguities recur.

### Pre-release chores

Small, non-spec tasks that ship as part of v1.0 and don't warrant their own phase-coded spec.

- **Node version policy.** Verify the framework runs on the current latest Node major (and every LTS line back to Node 20.10). Convert `install.sh`'s upper-bound Node check from a hard `die` to a `warn` that prints "Node X is newer than tested through (Node Y.x); continuing — please report issues." Lift the matching `engines` upper bound in `package.json`. Keep the lower bound (Node 20.10) as a hard error. Rationale: pre-v1.0 the cap was tested-against discipline; v1.0 needs to accept the audience most likely to file useful bug reports rather than block them at install time.

### Revision break — post-v1.0 dogfooding audit

When v1.0 has been used in real projects long enough to surface failure patterns from T1 trace data, every v1.1 spec is re-audited. Specs to revisit will include:

- **A1** — does the edit-fingerprint scheme catch the oscillation modes that actually appear in real runs? Refine the fingerprint algorithm if false-positive or false-negative rate is high.
- **T1** — does the trace schema carry every field downstream phases will need? Add fields surfaced as necessary by debugging real user reports. Bump `run-trace-vN` if breaking.
- **E5** — does one round and ≤ 3 blockers feel right? Does `--skip-clarification` get used? Are there ambiguity classes the minimal cut systematically misses?
- **U1/U2/U3** — does the project-overlay UX hold up against real users editing the file by hand? Refine validation errors and examples against actual mistake patterns.
- **O2** — does `--recover` hit edge cases in the prescriptive flow that weren't anticipated?

Same checkpoint discipline as the post-R, post-E1, post-M breaks. No v1.1 work begins until the audit closes.

## v1.1 — first iteration on real signal

Builds on T1's trace data and v1.0 user reports. Specs land in priority order, gated by what the data actually shows is broken.

- **A2 — Generator scope enforcement.** Framework-owned PreToolUse hook; sprint-declared file-glob writes only. Becomes urgent the first time a real user reports the agent touched something it shouldn't have. Glob granularity informed by v1.0 trace data.
- **Q2 — Failure-mode taxonomy.** Structured error codes (`HallucinatedSymbol`, `TestNotRun`, `LintNotFixed`, `ScopeViolation`, `LoopDetected`, …) replacing free-form prose feedback. Vocabulary shared with E5's clarifier-gap codes. Much easier to design *after* seeing actual failures in v1.0 traces.
- **T2 — Cost & efficiency surface.** `gan run report <run-id>` reads from T1 trace; `gan stats` aggregates across runs. Small spec; large UX win — users who can see "$0.40 / 38k tokens / 4m23s" trust the tool faster.
- **A4 — PII / secret regex catalog.** Per-stack regex bank (cards, SSN, JWT, AWS keys, etc.) layered on top of `secretsGlob`. Failures block the sprint, not just warn.
- **E5 round 2.** Multi-round clarification, confidence scoring per spec dimension, optional auto-promotion of resolved clarifications to project-tier `additionalContext` with explicit user confirmation.

## v1.2 — quality signal

Once meaningful production usage exists, the system can start measuring its own diff quality.

- **Q1 — Diff acceptance feedback loop.** Opt-in logging of merge / edit / revert outcomes under `.gan-state/feedback/`. `gan stats` reports acceptance / churn / revert rates per stack and per agent role. Single most valuable signal you can collect — but it requires actual production usage to be worth building.
- **A3 — Framework-owned destructive-action guard.** No deletes outside the run worktree; no rm/reset/force-push; no network egress without an allowlist. Stops leaning on host-harness hooks.
- **A5 — LLM-sampling reproducibility on verdict roles.** Pinned temperature/seed on evaluator and contract-reviewer. Generator stays sampled.
- **T3 — Budget enforcement.** Per-run token / $ ceilings as overlay splice points; agent halts with structured error on breach. Ceilings derived from T2 cost-distribution data, not guessed.

## v2.0 — agent evaluation

The big lift: from "framework that runs agents" to "framework that *measures* agents." None of this should land before v1.x is stable and used — the test sets and adversarial cases depend on usage shape.

- **V1 — LLM-verdict accuracy harness.** Curated (snapshot, evaluator-plan, expected-verdict) tuples; CI runs N times per case; verdict-accuracy and per-criterion calibration tracked. Promotes the originally-deferred E4 from optional to gating.
- **V2 — Variance budget.** Same input × M samples; agreement-rate threshold per criterion class. Catches prompt regressions that change verdicts without changing means.
- **V3 — Adversarial trap suite.** Hand-crafted false-positive bait — subtle bugs, plausible-but-wrong tests, security regressions disguised as fixes. Measures false-pass rate explicitly. The single most important quality metric in agentic systems isn't "did it succeed" — it's "did it falsely claim success."
- **B1 — SWE-bench Verified integration.** Nightly, not per-commit. Resolved-rate, patch-correctness, per-language splits as tracked CI artifact. Public scoreboard published per main commit.
- **B2 — In-house regression set.** Frozen tasks from real v1.x usage with golden-diff acceptance. Sourced from accumulated dogfooding, not hypothetical.
- **Q3 — Coverage delta tracking.** Per-stack `coverageCmd` + threshold splice point. Sprint fails if coverage drops without justification.
- **Q4 — Per-stack repo-convention checks.** `conventionCmd` slot for project-defined naming, layering, dependency rules. Lets a project encode "agents must not import X from Y" without patching the framework.

## Beyond v2.0

- **B3 — TerminalBench / Aider polyglot integration.** Reactivates once deferred S-series stacks (Android, KMP, iOS Swift) land — pre-building cross-language benchmarking before cross-language stacks exist is upside-down.
- **Deferred S-series stacks.** Android, KMP, iOS Swift per [`specifications/deferred/README.md`](deferred/README.md). Reactivation gated by the criteria there; the active plan's multi-stack guard rail (synthetic-second fixture + `lint-no-stack-leak` + cross-stack assertion in E3) keeps the framework honest until real S-series stacks land.
- **Additional real-ecosystem stacks.** Desktop, embedded, Python, Rust, Go follow the same template once the pattern proves on a second real ecosystem.

## Revision-break discipline

Every release closes with a revision-break audit. The pattern from the shipped phases holds: specs are revised in place against what implementation surfaced; new prescriptive authoring (when needed) lands inside the break, not after it; no next-release work begins until the break closes. v1.0 → v1.1 inherits this discipline; v1.1 → v1.2 and v1.2 → v2.0 likewise.

## Bite-size sizing

Every spec aims to be small enough that one sprint of focused work delivers a complete, mergeable result. Sprint-level slicing within a spec is noted in each spec's "Bite-size note" section.

## Cross-cutting principles

- **The Configuration API is a black box.** Agents know function names; they do not know storage, schemas, or merge logic. Specs F2 and R1 own the contract.
- **Maintainer tooling assumes Node 18+.** User-facing behavior is owned by the agent at runtime. iOS, embedded C++, Swift-only developers never need Node to use `/gan`.
- **Pre-1.0 WIP project until v1.0 ships.** No backward-compatibility guarantees pre-v1.0; any schema change bumps `schemaVersion`. No transitional dual-path windows. After v1.0, schema-version bumps remain available but breaking changes get release-note treatment.
- **CI workflow structure** locked to one file per test category plus a shared reusable workflow: `.github/workflows/{shared-setup,test-modules,test-evaluator-pipeline,test-stack-lint,test-schemas,test-no-stack-leak,test-error-text}.yml`. New categories follow `test-<category>.yml`.
- **Module ↔ stack name pairing** is enforced by the Configuration API at registration time. No separate lint subsystem needed.
- **Single-canonical stacks at the repo, plural at the project.** The repo promotes exactly one stack file per ecosystem. Users who want to diverge fork the file into their project tier (`.claude/gan/stacks/<name>.md`); C5's three-tier resolution makes that a one-line operation. There is no central N-versions registry, no curation queue, no community-vote process — PRs against the canonical file are the curation pipeline. This applies to the bootstrap stacks (`web-node`, plus the synthetic guard-rail fixture) and to any future ecosystem reactivated from `specifications/deferred/`. The scaffold (`gan stacks new`) is for users authoring project-tier customisations or contributing back upstream; both paths land in the same single-canonical model.
- **Replacement, not migration.** This spec set described a different architecture, not a refactor of the existing implementation. The shipped Phase 0–4 work used the **extract-and-replace** pattern: build new from spec, mine old prompts for content during E2, retire old artifacts as the specs that supersede them land.

  **Cleanup discipline.** Every implementation PR for a spec that retires old artifacts must delete those artifacts **in the same PR**. The retirement is part of the spec, not a follow-up. Lingering legacy is forbidden — dead prompts are especially dangerous because prompts compose by inclusion (a stale agent file may be picked up by search, by future authoring, or by a tool that scans `agents/`). The "Retirement table" below names every old artifact and the spec that retires it.

- **Multi-stack guard rail.** The active plan ships exactly one real ecosystem stack (`web-node`). To prevent the framework from calcifying around web-node assumptions while only one real stack exists, three mechanisms run together:
  1. A **synthetic fixture-only stack** (`tests/fixtures/stacks/synthetic-second/.claude/gan/stacks/synthetic-second.md`) lives in-tree from R1's first sprint slice. It is not a real ecosystem; it is a minimal stack that exercises every C1 schema field, both detection composites (`allOf` and `anyOf`), the cacheEnv conflict path, the securitySurfaces keyword + scope path, and `lintCmd.absenceSignal`. It is referenced from no production code path; its sole purpose is to be the "second stack" multi-stack code paths must work for.
  2. A **`lint-no-stack-leak` script** (R4) forbids web-node-specific identifiers (`package.json`, `node_modules`, `npm`, `pnpm`, `yarn`, `lockfile`, `.nvmrc`, etc. — the full list lives in R4 alongside the script) anywhere outside `stacks/web-node.md`, `tests/fixtures/stacks/js-ts-minimal/`, and explicitly-allowlisted maintainer-tooling files. Hits the script as a CI gate (`test-no-stack-leak.yml`).
  3. A **cross-stack capability assertion** in E3: the harness runs the synthetic stack's evaluator-plan fixture and asserts the deterministic core produces the expected output for it, side-by-side with `js-ts-minimal/`. Any framework change that breaks multi-stack semantics fails this check.

  The three together make it physically impossible for the framework to regress to single-stack without breaking CI. When a deferred S-series spec is reactivated, the synthetic stack and its supporting machinery stay — they remain a guard rail against a post-1.0 framework drifting toward whichever stacks happen to dominate its real-world use.

- **Release-driven from v1.0 forward.** Specs whose design quality depends on real-world usage data (V/B benchmarks, Q1 acceptance loop, T3 budget ceilings, A2 glob granularity, Q2 error-code vocabulary) are deliberately deferred to the release whose dogfooding produces that data. Pre-building them on speculation produces a worse spec set than waiting for signal.

## Retirements

Closed historical record of every old artifact retired during the redesign lives in [retirements.md](retirements.md). All Phase 0–4 retirements are completed; future specs that retire artifacts append to that file in the implementation PR.

**Cleanup discipline.** Every implementation PR for a spec that retires old artifacts must delete those artifacts in the same PR. Lingering legacy is forbidden — dead prompts are especially dangerous because prompts compose by inclusion. The reviewer checks the diff against the corresponding retirements.md rows; any survival blocks the merge.

## Branch strategy

The shipped phases built on `feature/stack-plugin-rfc` through Phase 3 (the cutover) and merged to main when Phase 3 closed. v1.0 work continues on `develop`; merges to `main` happen at release boundaries (v1.0, v1.1, v1.2, v2.0). No mid-release main carries a partially-built release.

## Out of scope for this roadmap

- **Cross-run learning / auto-curated project memory.** `/gan` stays a reader of documented overlay files; it never writes durable project knowledge *unless* the user explicitly confirms promotion (e.g. E5 v1.1's offer to save resolved clarifications as project-tier `additionalContext`). The framework never auto-curates; the user always confirms.
- **Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery.** Users opt in explicitly via `additionalContext` (U3).
- **Real-ecosystem stacks beyond `web-node` pre-v2.0.** The deferred S-series specs (Android, KMP, iOS Swift) capture a starting point; reactivation is gated by the criteria in [`specifications/deferred/README.md`](deferred/README.md). Desktop and embedded stacks follow the same template if and when the pattern is proven on a second real ecosystem.
- **Cross-language benchmarking pre-v2.0.** B3 (TerminalBench / Aider polyglot) waits for real cross-language stacks to exist.

## Runtime knobs

User-facing surfaces (flags, subcommands, env vars, prompt branches) are inventoried in [runtime-knobs.md](runtime-knobs.md). New knobs land there in the PR that adds them.

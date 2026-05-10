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
- **I** — install / installer
- **D** — diagnostics + user UX
- **H** — framework-owned hooks
- **W** — non-aborting warnings on user misuse
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
- [M3-module-surface-alignment.md](M3-module-surface-alignment.md) — Per-key state-file layout, `key` parameter on every module-state API function, `stateKeys` allowlist enforcement, `duplicatePolicy` on `appendToModuleState`, keyed-lookup `removeFromModuleState`. Implementation landed in PR #8 alongside the spec; the post-M F2 contract is now end-to-end aligned.

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

**Goal:** ship a usable product to early users so design assumptions get tested against real prompts, real codebases, and real failures. Sixteen items in v1.0: five carryover specs (O1 full surface, O2, U1, U2, U3), ten new specs (A1, T1, O3, E5, I1, I2, I3, D1, H1, W1), plus two documentation-only chores and inline amendments to F2/F3/F4/C2/R3. M3 already shipped during the post-M revision break.

The shape of the v1.0 user experience: a developer installs ClaudeAgents, edits `.claude/gan/project.md` to declare their project's quirks, runs `/gan` with a prompt, gets bounded clarifying questions on genuine ambiguities, sees a startup log telling them which stacks activated (with non-aborting warnings naming any overlay misuse), gets a sprint plan/contract/generation/evaluation cycle that won't loop forever, can `--recover` if interrupted, and can read a structured trace afterward to understand what happened.

**Effort estimate:** ~17–23 sprints of focused work, roughly 4–6 calendar months at one full-time developer. v1.0 is not a polish release — A1, T1, O3, E5, plus the install pipeline (I1/I2/I3), diagnostics (D1), hooks (H1), warnings (W1), and the M3 implementation gap below add up to ten substantive systems on top of six carryover items.

### Carryover

- **Full [O1-resolution-observability.md](O1-resolution-observability.md).** R1 already shipped the minimum-viable startup-log surface in Phase 2. v1.0 adds `gan config print`, `--print-config` JSON, and discard-array reporting. Without these, users can't debug their own setups without filing issues.
- **[O2-recovery.md](O2-recovery.md).** Per-run state archive, `--recover`, `--list-recoverable`. Spec already had its prescriptive authoring at the post-E1 break.
- **[U1-project-overlay-ux.md](U1-project-overlay-ux.md).** Hand-editable `.claude/gan/project.md`, validation errors, examples, mental-model guide. Project overlays are the reason the configuration API exists; v1.0 without them is a tech demo.
- **[U2-user-overlay-ux.md](U2-user-overlay-ux.md).** `~/.claude/gan/config.md`, cross-project preferences, auto-memory integration. Ships naturally with U1 — same surface, marginal cost.
- **[U3-additional-context-splice.md](U3-additional-context-splice.md).** `additionalContext` splice points for planner/proposer.

### New for v1.0

**Agent-loop safety, telemetry, observability, and clarification (4 specs):**

- **[A1](A1-loop-and-thrash-detection.md) — Loop & thrash detection.** Hard ceiling on attempts per sprint; edit-fingerprint history; halt with `LoopDetected` on oscillation. Single biggest safety gap in the current architecture; non-negotiable for v1.0. Doesn't need real-world data to design.
- **[T1](T1-structured-run-trace.md) — Structured run trace.** Every LLM call + tool call written under `.gan-state/runs/<id>/trace/` with prompt hash, response hash, token counts, cache-hit flag, latency, tool-call sequence. Schema at `schemas/run-trace-v1.json` per F3 conventions. T1 is the substrate every later phase reads from — landing it in v1.0 makes T2/V/B/Q materially cheaper to build later.
- **[O3](O3-telemetry-semantics.md) — Telemetry semantics.** Pins what `.gan-state/runs/<id>/telemetry/` captures (`config.json` resolved-config snapshot at run start, `outcome.json` sprint disposition + summary stats at termination), the local-only invariant (no transmission off-machine), and `--no-telemetry` flag semantics (skip writing the directory entirely). Schemas at `schemas/telemetry-config-v1.json` and `schemas/telemetry-outcome-v1.json` per F3 conventions. Closes the chore that "no spec defines what telemetry collects" — a defensible privacy posture for v1.0 release.
- **[E5](E5-spec-clarification.md) — Spec clarification phase.** New `gan-clarifier` agent role between user prompt ingestion and the planner. Identifies ambiguities and gaps, asks bounded blocker questions, declares assumptions for non-blocking gaps. Without this, v1.0 dogfooding signal is dominated by "the planner misread me" complaints, which mask everything else.

  **Minimal first cut for v1.0:** one round, ≤ 3 blockers, no auto-promotion to project context, no confidence scoring. The clarifier reads `additionalContext` (U3) first and asks only about what's still ambiguous. Iteration on round budget, confidence model, and persistence happens in v1.1 once usage shows which ambiguities recur.

**Install pipeline (3 specs):**

- **[I1](I1-self-contained-install-correctness.md) — Self-contained install correctness.** Real-file copies (not symlinks back to the source repo); `prepare` script in `package.json` so `npm install -g .` auto-builds `dist/`; post-install bin verification halts the install with a structured error if `claudeagents-config-server` is not on PATH; `engines.node` upper bound lifted (`>=20.10.0` only). The correctness layer of the install pipeline.
- **[I2](I2-install-user-facing-surfaces.md) — Install user-facing surfaces.** Post-install message names `/gan --help`; first-run welcome banner previews the trust prompt and clarifier draft preview before the user encounters them; permission-allowlist consent flow (8-category prompt with `[a]`/`[s]`/`[v]` shortcuts, atomic merge into `~/.claude/settings.json`, idempotent re-runs, surgical uninstall). The UX layer.
- **[I3](I3-uninstall-and-version-policy.md) — Uninstall and version policy.** Symmetric uninstall (`npm uninstall -g @claudeagents/config-server` after filesystem cleanup) with post-uninstall restart hint; Node version policy (warn-not-die for the upper bound); MCP registration with absolute bin path (closes the macOS GUI-PATH bug). The cleanup + hardening layer.

**Diagnostics + UX (1 spec):**

- **[D1](D1-diagnostic-clarity.md) — Diagnostic clarity.** `ConfigApiUnreachable` branching (distinguishes installed-but-needs-restart from not-installed from bin-missing); SKILL.md status markers (`[shipped-in-v1.0]` / `[deferred-to-v1.1]` / `[partial-v1.0]`) with runtime alignment (deferred flags short-circuit with "requires v1.1"); `gan stacks --help` advertises all six subcommands with an "Active vs. available" paragraph. Three diagnostic surfaces unified under a single discipline: match the diagnostic to the user's actual state, not the most-common case.

**Framework-owned hooks (1 spec):**

- **[H1](H1-framework-owned-confinement-hook.md) — Framework-owned filesystem-zone enforcement hook.** `gan-confine.sh` migrated from project-tier to user-tier; written by `install.sh` to `~/.claude/hooks/`; refreshed on each install. Project-tier hooks remain optional overrides. Closes the implicit cross-version coupling where every F1 zone rework silently broke every project that adopted a hook pattern.

**Non-aborting warnings (1 spec):**

- **[W1](W1-overlay-misuse-warnings.md) — Overlay-misuse warnings.** Two cases where the framework accepts user overlay declarations that don't have the user's apparent intent: `StackOverrideShrinkage` (when `stack.override` produces a smaller active set than detection would have); `PerStackOverrideUnsupported` (when an overlay declares per-stack command overrides, which v1.0 does not implement and v1.1 will). Both surface in the orchestrator startup log, `gan stacks list`, and `gan config print`. Non-aborting; the user's overlay IS their intent and runs as written, but the divergence between intent and effect is now visible.

### Implementation order

Dependency-ordered sequence the v1.0 work lands in. Each item gates the items below it.

1. ~~**M3 implementation.**~~ ✅ Shipped in PR #8 alongside the spec.
2. **I1 — Self-contained install correctness.** Copies-not-symlinks, `prepare` script, post-install bin verification. The install pipeline must be honest before any other v1.0 work lands, otherwise downstream features ship behind a misleading install. ~1 sprint. ✅ Shipped in PR #9.
3. **I3 — Uninstall and version policy.** Symmetric uninstall (npm package removal), Node version warn-not-die, MCP absolute-path registration. ~1–2 sprints. ✅ Shipped — symmetric uninstall and MCP absolute-path registration in PR #9; Node version warn-not-die in PR #10.
4. **I2 — Install user-facing surfaces.** Post-install message, first-run welcome banner, permission consent flow. ~3–4 sprints. Depends on I1 (working install) and I3 (settings.json patterns).
5. **F2 cache-coherence amendment + F3 schema-runtime alignment chore.** Resolver invalidation on writes; filter `NotImplemented` tools from advertised list. ~1 sprint combined. Closes the dogfooding session's "trustApprove cache staleness" bug.
6. **T1 schema authoring + event-emission infrastructure.** Substrate every later v1.0 item reads from. ~2–3 sprints. Must land before A1 (which extends T1's `safetyHalt` extension point) and before E5 (which adds T1's `clarifierFinding` event class).
7. **H1 — Framework-owned confinement hook.** `gan-confine.sh` migrated from project-tier to user-tier; `install.sh` writes and refreshes. ~1–2 sprints. Lands between install pipeline (I1–I3) and orchestrator-level v1.0 work (A1, E5) so confinement is correct before agent flows ship.
8. **A1 implementation.** Includes new C1 stack-file fields (`commentSyntax`, `sortableLists`), web-node + generic + synthetic-second field population, fingerprint algorithm, halt contract, recovery integration. ~3–4 sprints. Depends on T1.
9. **E5 implementation.** Includes R1 snapshot extension (bounded directory listing), SKILL.md insertion of the clarifier between user-prompt ingestion and the planner, agent prompt authoring, finding-class trace events. ~3–4 sprints. Can run in parallel with A1 once T1 is landed; must coordinate with A1 on shared sprint-budget interaction.
10. **W1 — Overlay-misuse warnings.** Resolver-level `StackOverrideShrinkage` and `PerStackOverrideUnsupported`; surfaces in startup log, `gan stacks list`, `gan config print`. ~2 sprints. Depends on F2's structured-warning catalog extension (which lands as a small piece in W1's first sprint).
11. **D1 — Diagnostic clarity.** `ConfigApiUnreachable` branching, SKILL.md status markers + lint, `gan stacks --help` rewrite. ~2–3 sprints. Lands late because the SKILL.md status markers depend on knowing which v1.0 sections are operative — so D1's marker pass benefits from waiting until A1, E5 are merged.
12. **O3 — Telemetry semantics implementation.** Schema authoring (`telemetry-config-v1.json`, `telemetry-outcome-v1.json`), `config.json` emission at run start, `outcome.json` emission at run termination, `--no-telemetry` flag. ~2–3 sprints. Depends on T1 (cost aggregate is derived from T1 trace events). Can run in parallel with W1 / D1 once T1 is landed.
13. **O1 full surface, O2 implementation, U1/U2/U3 implementation.** Polish on existing primitives. ~2–3 sprints across all five.
14. **Pre-release chores** (below). README inventory.

Slices 2–4 (I-series) can land in parallel where dependencies allow. Slice 5 is small and can land any time after I1. Slices 6–12 are the substantive v1.0 work and have clear dependency relationships called out above. Slice 13 is polish; slice 14 is documentation. The post-v1.0 dogfooding audit fires after slice 14.

### Known gaps accepted at v1.0

Documented limitations that ship with v1.0 by design. Each is named so dogfooding signal isn't surprised by them.

- **No CI test for end-to-end orchestrator flow.** The deterministic core has golden-file harness coverage; `validateAll()` and `getResolvedConfig()` are unit-tested; the trust prompt has a UX test. There is no automated test that exercises a full `/gan` invocation (validateAll → snapshot → spawn agent → re-snapshot on mutation → spawn next agent → terminate). v1.0 dogfooding is the implicit test surface for orchestrator control flow. A regression in `SKILL.md` ordering (especially around E5's clarifier insertion) would be caught by a real user, not CI. Building the orchestrator-side test harness is V1's scope in v2.0.
- **Per-stack overlay command override returns 0 for `perStackOverridesCount`.** [`reads.ts:329–332`](../src/config-server/tools/reads.ts) carries an explicit "post-E1 work" comment; project overlays attempting to override a stack's `auditCmd` / `buildCmd` / `testCmd` / `lintCmd` silently no-op. Most users don't override per-stack commands, so the surface is rarely exercised, but the failure mode (overlay declares an override, framework ignores it without warning) is the worst kind. [W1](W1-overlay-misuse-warnings.md) adds a `PerStackOverrideUnsupported` structured warning so the limitation is visible. Full implementation lands in v1.1.

### Pre-release chores

Small, non-spec tasks that ship as part of v1.0 and don't warrant their own phase-coded spec. Items that DID warrant a spec are listed under "New for v1.0" above.

- **README v1.0 stack and module inventory.** Add two clearly-labelled inventory sections to the README: "Stacks available in v1.0" and "Modules available in v1.0". The stack section lists `web-node` (real ecosystem) and `generic` (fallback) with one-line descriptions of what each detects and what it provides. The module section lists modules that ship with v1.0 (currently only `docker`, per M2) with what each does, what stack it pairs with (`pairsWith`), and what state it persists. Both sections include a forward-looking note that additional stacks/modules may ship in later releases. Rationale: a user authoring a project overlay shouldn't have to read C / M-series specs to discover what's available. Same surface as U1's mental-model guide; lives at the top of the README.

- **Drop `NotImplemented` tools from the advertised tool list.** `getOverlayField` and `getStackConventions` ship as `NotImplemented` stubs but appear in the MCP `tools/list` response. Listing tools that always throw is worse than not listing them — the agent reads the schema, calls the tool, gets `NotImplemented`, and has no signal that the tool was never real in this version. One-line filter in `buildToolList()` excludes any tool whose dispatch path is `NotImplemented`. When the tools land in v1.1, they re-appear automatically. Surfaces under F3's "Schema-runtime alignment" amendment; the chore is the implementation step.

### Inline amendments to existing specs

Cross-cutting fixes to existing specs that were folded in directly rather than promoted to standalone amendment specs. Each is a subsection edit in its parent spec.

- **F2 — Server-side cache coherence on state-mutating writes.** Resolver caches must invalidate on every state-mutating tool call (writes, `trustApprove`, `trustRevoke`); mtime-driven invalidation catches hand-edits. New "Server-side cache coherence" subsection in F2 distinguishes this from the existing orchestrator-side snapshot-freshness rule.
- **F3 — Schema-runtime alignment for MCP tool surfaces.** Schema declarations and runtime validators must agree on tool-input shape. v1.0 surgical fixes (filter `NotImplemented` tools out of the advertised list, manual parameter-shape audit). v1.1 structural fix (generate or CI-enforce). New "Schema-runtime alignment" subsection in F3.
- **F4 — Trust prompt is a protocol, not a server-side gate.** `trustApprove` is agent-callable; the prompt UX is a protocol the orchestrator is contracted to obey, not a hard gate the server enforces. New subsection in F4 documents the threat-model implication. v1.1 amendment will consider server-side enforcement options.
- **C2 — `stack.override` silent-shrinkage warning.** New "Silent-shrinkage warning" subsection in C2 requires the resolver to emit a `StackOverrideShrinkage` warning when the override produces an active set smaller than detection would have. Surfaces via [W1](W1-overlay-misuse-warnings.md).
- **R3 — `gan stacks new` tier-aware scaffold.** R3's scaffold contract becomes tier-aware: project-tier scaffolds omit `detection:` (forbidden at that tier) and include a comment pointing at `stack.override`; user-tier scaffolds keep `detection:`. Closes the first-use trap that bit the dogfooding session.

### Revision break — post-v1.0 dogfooding audit

When v1.0 has been used in real projects long enough to surface failure patterns from T1 trace data, every v1.1 spec is re-audited. Specs to revisit will include:

- **A1** — does the edit-fingerprint scheme catch the oscillation modes that actually appear in real runs? Refine the fingerprint algorithm if false-positive or false-negative rate is high.
- **T1** — does the trace schema carry every field downstream phases will need? Add fields surfaced as necessary by debugging real user reports. Bump `run-trace-vN` if breaking.
- **E5** — does one round and ≤ 3 blockers feel right? Does `--skip-clarification` get used? Are there ambiguity classes the minimal cut systematically misses?
- **U1/U2/U3** — does the project-overlay UX hold up against real users editing the file by hand? Refine validation errors and examples against actual mistake patterns.
- **O2** — does `--recover` hit edge cases in the prescriptive flow that weren't anticipated?
- **M3** — does the per-key state-file layout perform as expected once a second module ships state? Audit at v1.1 with the orchestrator-test harness work below.
- **I1/I2/I3** — does the install pipeline survive real-world variations (different Node versions, npm prefixes, GUI launch contexts)? Refine the post-install bin verification, the welcome banner content, and the permission consent flow against what users actually trip on.
- **D1** — does `ConfigApiUnreachable` branching produce the right remediation for the cases users hit? Are SKILL.md status markers preserved across spec edits?
- **H1** — does the user-tier hook ownership shift produce silent project-tier-override drift in practice? Audit `gan hooks status` adoption.
- **W1** — do users find the `StackOverrideShrinkage` and `PerStackOverrideUnsupported` warnings actionable? Refine wording if confused users filed bugs against them.
- **O3** — is `outcome.json` capturing the summary fields downstream tooling actually wants? Are users reaching for `--no-telemetry`, and if so, why? Does the local-only invariant hold up under user expectations, or do users want a per-project default-off knob (candidate v1.1 overlay splice point `telemetry.disabled`)?
- **Orchestrator end-to-end test gap** — review whether v1.0 dogfooding produced enough orchestrator-flow regressions to motivate building the test harness in v1.1 (rather than waiting for v2.0's V1). If yes, scope an interim spec; if no, hold the line.

Same checkpoint discipline as the post-R, post-E1, post-M breaks. No v1.1 work begins until the audit closes.

## v1.1 — first iteration on real signal

Builds on T1's trace data and v1.0 user reports. Specs land in priority order, gated by what the data actually shows is broken.

- **[A2](A2-generator-scope-enforcement.md) — Generator scope enforcement.** Framework-owned PreToolUse hook; sprint-declared file-glob writes only. Becomes urgent the first time a real user reports the agent touched something it shouldn't have. Glob granularity informed by v1.0 trace data. Includes **per-role scope splits within a stack**: the writing agent does not need access to credential files; the lint-running agent does not need write access to source. Today `scope` globs are per-stack; A2 adds a per-role refinement so each agent role inside a sprint has its own allow/deny set, derived from the stack's base scope plus role-specific narrowing rules. Default behavior is unchanged (all roles see the stack's full scope); narrowing is opt-in and audited via the trace.
- **Q2 — Failure-mode taxonomy.** Structured error codes (`HallucinatedSymbol`, `TestNotRun`, `LintNotFixed`, `ScopeViolation`, `LoopDetected`, `ConfidentlyWrong`, …) replacing free-form prose feedback. `ConfidentlyWrong` is the operator-style heuristic for "high confidence, low evidence" outputs — fires when an evaluator emits a `pass` verdict with thin `evidence.traceEventRefs` (small array, no concrete `reproductionCommand`) on a criterion whose rubric expects substantive proof. Tunable threshold; pairs with V1's confidence-calibration tracking in v2.0. Vocabulary shared with E5's clarifier-gap codes. Much easier to design *after* seeing actual failures in v1.0 traces.
- **T2 — Cost & efficiency surface.** `gan run report <run-id>` reads from T1 trace; `gan stats` aggregates across runs. Small spec; large UX win — users who can see "$0.40 / 38k tokens / 4m23s" trust the tool faster.
- **A4 — PII / secret regex catalog.** Per-stack regex bank (cards, SSN, JWT, AWS keys, etc.) layered on top of `secretsGlob`. Failures block the sprint, not just warn.
- **E5 round 2.** Confidence scoring per spec dimension drives adaptive round depth (replacing v1.0's fixed three-round cap); optional auto-promotion of resolved clarifications to project-tier `additionalContext` with explicit user confirmation. Multi-round clarification (initial + two evolutions) and the draft-preview interaction surface already shipped in v1.0; v1.1's work is the confidence-scored adaptation and the persistence path.
- **Per-stack overlay command override completion.** Replaces [W1](W1-overlay-misuse-warnings.md)'s `PerStackOverrideUnsupported` warning with the real implementation. Project overlays declaring `<stack>.auditCmd` / `buildCmd` / `testCmd` / `lintCmd` flow through the snapshot to the orchestrator and evaluator-core. Closes the post-E1 work tracked at `reads.ts:329-332`.

- **Schema-runtime alignment via generation or contract tests.** v1.0 ships the surgical fix (filter `NotImplemented` tools out of the advertised list). v1.1 closes the structural gap: either (a) generate `schemas/api-tools-v1.json` from the runtime validators at build time, OR (b) add CI that calls every tool with deliberately-bad input and asserts the runtime error matches the schema's `required`-field declarations. (a) is the load-bearing fix; (b) is a backstop. The dogfooding session caught two drifts in a single run; without this discipline more will accumulate.

- **F4 trust-prompt enforcement.** v1.0 ships the documentation fix (acknowledge `trustApprove` is agent-callable; the orchestrator's faithful surfacing is part of the threat-model trusted base). v1.1 adds server-side enforcement options as a real F4 amendment: rate-limiting per session, content-hash echo (the call must include the hash the user just saw), structured audit log surfaced back to the user, and **scoped capability tokens** as the implementation form of trust ladder rungs 4–5 (per [F4's "Capability tokens" subsection](F4-threat-model-and-trust.md)). A capability token is bound to a `(content-hash, project-root)` pair, carries optional expiry (N runs or T seconds), and is surrendered after consumption. Tokens replace the binary "approved hash is in the cache" check with a finer-grained, audit-logged grant. Spec lays out trade-offs across rate-limiting, hash-echo, audit log, and capability tokens; picks one or two.

- **`getMergedSplicePoints` inclusion-rule documentation.** F2 docs the rule for which fields appear in `getMergedSplicePoints` output: scalar / list / map splice points participate; reserved fields like `stack.override` (override-not-merge) are deliberately excluded and surface via `getResolvedConfig.overlay.stack.override` instead. The dogfooding session caught the terminology drift between "splice point" (data-flow term) and "override" (user-facing term) without docs to reconcile them. Documentation-only; no behavior change.

- **Stack-file naming convention.** C1 publishes a one-paragraph rule for stack-file names. Pattern candidates: `<runtime>-<framework>` (matches existing `web-node`), `<language>-<framework>`, `<ecosystem-tag>`. Pick one and document. Matters more once `gan stacks list` has 5+ entries and users are scaffolding their own.

## v1.2 — quality signal

Once meaningful production usage exists, the system can start measuring its own diff quality.

- **Q1 — Diff acceptance feedback loop.** Opt-in logging of merge / edit / revert outcomes under `.gan-state/feedback/`. `gan stats` reports acceptance / churn / revert rates per stack and per agent role. Single most valuable signal you can collect — but it requires actual production usage to be worth building.
- **A3 — Framework-owned destructive-action guard.** No deletes outside the run worktree; no rm/reset/force-push; no network egress without an allowlist. Stops leaning on host-harness hooks.
- **A5 — LLM-sampling reproducibility on verdict roles.** Pinned temperature/seed on evaluator and contract-reviewer. Generator stays sampled.
- **[E6](E6-pluggable-evaluator-role.md) — Pluggable evaluator role.** Swap the LLM evaluator agent for a human reviewer at the same contract boundary, without disturbing proposer / generator / orchestrator code paths. The human writes the same evaluator-evidence-bundle artifact (per T1) the LLM agent would have written; the orchestrator reads it the same way. UX surface: a `/gan --human-eval` flag pauses the run after generation, opens the contract + diff + plan in the user's editor with a pre-populated bundle template, and waits for the bundle to be written. Carries a `humanReview` event class in the trace so post-hoc analysis can distinguish human vs. LLM verdicts when comparing across runs. Operator framing: when stakes warrant it, the evaluator slot should be a role, not a hardcoded LLM call.
- **T3 — Budget enforcement.** Per-run token / $ ceilings as overlay splice points; agent halts with structured error on breach. Ceilings derived from T2 cost-distribution data, not guessed. Lights up A1's reserved `tokenBudgetExceeded` and `wallClockBudgetExceeded` halt discriminators (per A1's "Quantitative budget extension point" subsection) — same `LoopDetected` error code, same `safetyHalt` event class, no schema bump.

## v2.0 — agent evaluation

The big lift: from "framework that runs agents" to "framework that *measures* agents." None of this should land before v1.x is stable and used — the test sets and adversarial cases depend on usage shape.

- **V1 — LLM-verdict accuracy harness.** Curated (snapshot, evaluator-plan, expected-verdict) tuples; CI runs N times per case; verdict-accuracy and per-criterion calibration tracked. Includes a **confidence-calibration** dimension: every evaluator verdict is scored not only on correctness but on how well its confidence (proxied by `evidence.traceEventRefs.length`, presence of `reproductionCommand`, completeness of `deltaFromContract`) tracks reality. High-confidence-low-evidence outputs are flagged even when correct — the operator-style insight that "right for the wrong reasons" is still a regression signal. Pairs with v1.1's `ConfidentlyWrong` Q2 code: V1 produces calibration data, Q2 acts on it at runtime. Promotes the originally-deferred E4 from optional to gating.
- **V2 — Variance budget.** Same input × M samples; agreement-rate threshold per criterion class. Catches prompt regressions that change verdicts without changing means.
- **V3 — Adversarial trap suite.** Hand-crafted false-positive bait — subtle bugs, plausible-but-wrong tests, security regressions disguised as fixes. Measures false-pass rate explicitly. The single most important quality metric in agentic systems isn't "did it succeed" — it's "did it falsely claim success." Includes **planted-trap fixtures** (per-stack): seed inputs with known fakes, duplicates, conflicting requirements, citations to non-existent files, and other bait the agent should reject. Score on rejection rate per trap class. Sharper signal than rubric scoring — a single `fixture-with-planted-fake` either flags it or doesn't, no judgment call. Each shipped stack carries a small trap fixture set under `tests/fixtures/stacks/<name>/traps/`; the framework's CI tracks rejection rate as a per-stack health metric.
- **B1 — SWE-bench Verified integration.** Nightly, not per-commit. Resolved-rate, patch-correctness, per-language splits as tracked CI artifact. Public scoreboard published per main commit.
- **B2 — In-house regression set.** Frozen tasks from real v1.x usage with golden-diff acceptance. Sourced from accumulated dogfooding, not hypothetical.
- **Q3 — Coverage delta tracking.** Per-stack `coverageCmd` + threshold splice point. Sprint fails if coverage drops without justification.
- **Q4 — Per-stack repo-convention checks.** `conventionCmd` slot for project-defined naming, layering, dependency rules. Lets a project encode "agents must not import X from Y" without patching the framework.
- **C6 — Per-step model routing in stack files.** New stack-file field declaring which model class an agent role should use for a given job class — cheap-triage / frontier-reasoning / local-bulk are the operator-named tiers. Today the framework treats "the LLM" as undifferentiated; in practice the contract-proposer (judgment) and the generator (production) want different models for different reasons, and stacks know which trade-off matters in their ecosystem. Defaults are model-agnostic ("any frontier"); stacks may pin specific tiers (`{ generator: "frontier-coding", evaluator: "frontier-reasoning", clarifier: "cheap-triage" }`). Routing rules are advisory unless an overlay marks them strict. Lands in v2.0 because the design quality depends on V/B benchmark data (from V1, V2, V3, B1, B2) showing which model serves which job class best — pre-2.0 routing rules would be guesses.

## Beyond v2.0

- **B3 — TerminalBench / Aider polyglot integration.** Reactivates once deferred S-series stacks (Android, KMP, iOS Swift) land — pre-building cross-language benchmarking before cross-language stacks exist is upside-down.
- **Deferred S-series stacks.** Android, KMP, iOS Swift per [`specifications/deferred/README.md`](deferred/README.md). Reactivation gated by the criteria there; the active plan's multi-stack guard rail (synthetic-second fixture + `lint-no-stack-leak` + cross-stack assertion in E3) keeps the framework honest until real S-series stacks land.
- **Additional real-ecosystem stacks.** Desktop, embedded, Python, Rust, Go follow the same template once the pattern proves on a second real ecosystem.
- **Plugin marketplace + share/install flow.** A discoverability surface for community-authored stacks, modules, and overlay templates, plus a `gan plugins install <ref>` install path that runs through the trust ladder (per F4). Two operator-named requirements before the marketplace earns its keep: a **discoverability surface** (tags, search, ratings, badge for "framework-validated") and a **shipping cadence** (regular updates, deprecation policy, version pinning). A marketplace without those is a graveyard of stale plugins; with them it compounds. Depends on stable plugin/skill formats (which v1.0 establishes) and a trust model that survives third-party content (which F4 + capability tokens in v1.1 establish). Pre-marketplace, sharing happens via PRs against the canonical `stacks/` directory and direct file copying — adequate for the framework's pre-marketplace reach.

## Revision-break discipline

Every release closes with a revision-break audit. The pattern from the shipped phases holds: specs are revised in place against what implementation surfaced; new prescriptive authoring (when needed) lands inside the break, not after it; no next-release work begins until the break closes. v1.0 → v1.1 inherits this discipline; v1.1 → v1.2 and v1.2 → v2.0 likewise.

## Bite-size sizing

Every spec aims to be small enough that one sprint of focused work delivers a complete, mergeable result. Sprint-level slicing within a spec is noted in each spec's "Bite-size note" section.

## Cross-cutting principles

- **The Configuration API is a black box.** Agents know function names; they do not know storage, schemas, or merge logic. Specs F2 and R1 own the contract.
- **Maintainer tooling assumes Node 18+.** User-facing behavior is owned by the agent at runtime. iOS, embedded C++, Swift-only developers never need Node to use `/gan`.
- **Pre-1.0 WIP project until v1.0 ships.** No backward-compatibility guarantees pre-v1.0; any schema change bumps `schemaVersion`. No transitional dual-path windows. **Schema discipline tightens at v1.0 cut**: from v1.0 onward, additive changes (new optional fields, new discriminator values within an existing event class, new event classes) stay on `vN`; field-rename or semantic-change forces `vN+1` with release-note treatment. Schemas affected by v1.0 work — `stack-v1.json` (A1's `commentSyntax`, `sortableLists`), `overlay-v1.json` (A1's `safety.*`, T1's `telemetry.tracePayloads`), `progress-v1.json` (O2's terminalReason additions), new `run-trace-v1.json` and `run-trace-index-v1.json` (T1), new `evaluator-evidence-bundle-v1.json` (T1's per-criterion evaluator output contract), new `telemetry-config-v1.json` and `telemetry-outcome-v1.json` (O3's run-summary artifacts) — all land in v1.0 implementation PRs and are frozen at v1.0 release.
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

- **Cache coherence on state-mutating writes.** Every API call that mutates configuration files (overlay edits, stack edits, `trustApprove`, `trustRevoke`, module-state writes) must invalidate the resolver's data caches before returning, AND mtime-driven invalidation must catch hand-edits that bypass the API. F2 owns the contract; R1 owns the implementation. Without this, callers see stale state on the very next read — exactly the failure mode that bit the first dogfooding session. The orchestrator's snapshot-freshness rule (re-snapshot on `mutated:true`) is necessary but not sufficient — it covers the orchestrator's view, not the server's internal caches. Both layers must coexist.

- **Schema-runtime alignment.** F3's "schema authority" principle is a write-time discipline today (the publish-schemas script). It is not a generation discipline — schemas at `schemas/api-tools-v1.json` and runtime validators in `src/config-server/tools/` are independent code paths and can drift. v1.0 fix: filter `NotImplemented` tools out of the advertised list so the schema doesn't promise tools the runtime won't deliver. v1.1 fix: either generate the JSON Schema from runtime validators at build time, OR add CI that exercises every tool with deliberately-bad input and asserts the runtime error matches the schema's `required`-field list. The principle is named here so future tool additions don't drift quietly.

- **Spec-vs-shipped status markers.** Specs that describe forward-looking behavior (orchestrator skill flows, agent prompts, multi-stage feature rollouts) carry per-section status markers: `[shipped-in-v<release>]` (operative now), `[deferred-to-v<release>]` (described for forward-compat, not yet operative), `[partial-v<release>]` (minimal viable shipped, full version in a later release). Without markers, an implementer reading the spec from scratch has no signal that some sections describe aspirational behavior the server can't yet deliver. SKILL.md is the load-bearing offender today (`--recover` and `--list-recoverable` reference an unshipped O2). A1, T1, E5 are the next at risk as they ship in stages. Discipline applies across all spec families post-v1.0.

- **Framework owns user-tier hooks for filesystem-zone enforcement.** Hooks that enforce framework-defined invariants (today: `gan-confine.sh` enforcing the F1 zone boundary) are the framework's responsibility to author and update. They live at `~/.claude/hooks/` (user-tier), are written by `install.sh`, and are refreshed on each re-install. Project-tier hooks remain optional overrides for projects that need narrower or wider constraints. Without this rule, every framework filesystem rework silently breaks every project that adopted a hook pattern, with no upgrade path short of every user manually editing every project.

- **Five-question relevance filter for new capabilities.** Any proposed primitive, splice point, runtime knob, or agent-surface addition is triaged against five questions before it earns a spec slot. The filter keeps the framework as *infrastructure other things build on*, not as a grab-bag of features:

  1. **Does it plug into the framework's existing primitives** (Configuration API, stacks, overlays, modules, hooks, trace), or does it reach around them?
  2. **Can other agents, plugins, or future specs build on top of it** without re-implementing its logic? (composability test)
  3. **Does it own or access durable, structured state** (zone 2 artifacts, configuration, trace), or is it ephemeral chat-style behavior?
  4. **Does it fit the existing ecosystem boundaries** (stack/module pairing, three-zone discipline, three-tier overlay cascade, schema-versioning rules), or does it require carving a new ownership lane?
  5. **Can it be stacked or composed with other capabilities**, or is it a terminal feature whose use case is exhausted by its first invocation?

  A proposal that fails three of the five is a feature, not infrastructure. Features are not rejected — they are deferred until either the failing dimensions are closed by other infrastructure work or until release-driven dogfooding shows the feature compounds into something more general. The filter applies prospectively: anyone proposing a new spec includes the five-question answer in the spec's "Problem" section. Reviewers use the answers to challenge whether the work belongs in this release or a later one.

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

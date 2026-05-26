# ClaudeAgents — Roadmap

## End state

ClaudeAgents is a framework for AI-driven software development workflows — sprint planning, code generation, review, verification — that works on any technology stack. When this redesign is fully shipped, a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, and more) installs ClaudeAgents once, restarts Claude Code once, and `/gan` operates on their project. Adding support for a new ecosystem is a file drop, not a code change. Node is required once at install time (the framework is distributed via npm); after install, daily workflow on a non-Node ecosystem never touches Node.

The architectural backbone is a **Configuration API** that hides storage, validation, and merging behind a small set of named functions. Agents call those functions; they do not parse files, do not know schemas, and do not enumerate tiers. Stack files declare per-ecosystem behavior; overlays apply per-user and per-project customization through a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config, durable state, and cache zones with non-overlapping lifecycles, so persistent module state cannot collide with per-run orchestration data. Configuration files are hand-editable; the API validates on read and surfaces structured errors when something is wrong.

The plan is now **release-driven**. Phases 0–4 (foundations, configuration, reference implementation, agent integration, modules) have shipped and provide the architectural spine. The active plan is structured as **v1.0 → v1.1 → v1.2 → v2.0 → beyond**: each release ships a coherent slice that gives real-world signal before the next slice is designed in detail. Specs that depend on usage data to be authored well are deliberately deferred until that data exists.

**Organizing principle — trust before measurement.** Releases are sorted by one test: *does this make the code the framework emits more trustworthy?* The orchestrator and agents run as markdown executed by Claude, so they can call only what is exposed as an MCP tool or `gan` CLI subcommand. Today that is the config server alone — the `trace`, `safety`, and `evaluator-core` libraries and the module helpers are shipped and tested but uncallable from a markdown orchestrator, and the evaluator has never rejected a sprint. v1.0 therefore delivers the **mechanism** of a trustworthy loop: a runtime bridge that makes those libraries operative, and an evaluator that can actually reject. v2.0 delivers the harness that **measures** how good that trust is. Mechanism precedes measurement, never the reverse.

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

**Before you edit any spec, read the "Specification lifecycle" section immediately below.** Once a spec's implementation has merged to `develop`, the spec is gated — no further edits to its prose are accepted. New behaviour goes in a new spec or folds into an unimplemented one.

## Specification lifecycle — read this before editing any spec

| State | Definition |
|---|---|
| **Draft** | Spec file exists; implementation has not merged to `develop`. Editable. |
| **Shipped** | Implementation PR has merged to `develop`. **Gated; not editable.** |
| **Released** | Spec is in a tagged release. Still gated. |

**Shipped specs are immutable.** No edits to a shipped spec's prose are accepted — not for regression fixes, refinements, new behaviour, or documentation polish. No exception path during normal work.

Changes that would touch a shipped spec take one of two paths: (1) author a new spec under the next free phase-coded slot, or (2) fold the change into an unimplemented spec that already touches the same code. The roadmap is the cross-reference layer — readers of a shipped spec find related newer behaviour via the roadmap, not via in-place edits.

Full convention with rationale lives in [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) § "Conventions".

## Shipped

Phases 0–4 (foundations F1–F4; configuration domains C1–C5; reference implementation R1–R5; agent integration E1–E3; modules M1–M3) have shipped. See the spec files in `specifications/` for the contract each one carries. v1.0 items already merged are marked ✅ in the implementation order below.

## v1.0 — first release

**Goal:** ship a product whose output a user can *trust* — a loop that can actually reject bad code — to early users, so design assumptions get tested against real prompts, real codebases, and real failures. The release test for every item: *does it make the code the framework emits more trustworthy?* If an item does not, it is not a v1.0 item.

**User experience target:** a developer installs ClaudeAgents, edits `.claude/gan/project.md` to declare their project's quirks, runs `/gan` with a prompt, gets bounded clarifying questions on genuine ambiguities, sees a startup log naming active stacks (with non-aborting warnings on overlay misuse), and gets a plan/contract/generation/evaluation cycle that won't loop forever (the safety layer actually fires), is independently reviewed for defects the contract never anticipated (the gate can reject, not just rubber-stamp), emits a real structured trace they can read, and can `--recover` if interrupted.

**Effort estimate:** ~32–42 sprints of focused work (~8–11 calendar months at one full-time developer). The two new specs — R7 (runtime bridge) and E8 (independent review + forced verification) — are roughly a third of that and sit on the critical path; the overlay-UX polish (U1/U2/U3) moves to v1.1 to make room for them.

### Implementation order

The numbered list below IS the v1.0 spec inventory. Each entry is one line: spec link, position rationale, dependencies. Spec content lives in the spec files.

1. ✅ **M3** — module surface alignment. Shipped PR #8.
2. ✅ **I1** — self-contained install correctness. Shipped PR #9.
3. ✅ **I3** — uninstall + version policy. Shipped PR #9 (slices 1+3) and PR #10 (slice 2).
4. ✅ **I2** — install user-facing surfaces. Shipped PR #13.
5. ✅ **F5** — config API surface coherence. Shipped PR #14.
6. ✅ **R6** — tier-aware stack scaffold. Shipped PR #16.
7. ✅ **F6** — trust-prompt protocol clarification. Shipped PR #18.
8. ✅ **T1** — structured run trace. Shipped PR #19. *(Run-data and trace location relocated to the central store by F7 — see slot 10. Made operative from a markdown orchestrator by R7 — see slot 15.)*
9. ✅ **H1** — framework-owned confinement hook. Shipped PR #21. *(Hook path construction superseded by F7 — see slot 10.)*
10. ✅ **F7** — centralized run-data store + worktree-aware execution. Shipped PR #23. Relocates run data to a central, repo-keyed store (`~/.gan-runs-data`) so it survives worktree removal; makes `/gan` reuse a task worktree in place (1a/1b/1c). Supersedes the run-data/trace location in F1/T1 and the confinement-hook path construction in H1 (those shipped specs are not edited; this entry is their cross-reference). Edits unimplemented O2/O3 and draft H2. Lands before A1/E5/O2/O3 so run paths and confinement are settled before those build on them.
11. ✅ **[F8](F8-centralized-module-state-store.md)** — centralized repo-keyed module-state store. Shipped PR #24. Pairs with F7 (the same zone-2 worktree-removal fix, for module state): relocates `.gan-state/modules/` to a separate repo-keyed store (`~/.gan-module-state`), fixing both the durability footgun and a latent M2 cross-worktree port-collision bug. Depends on F7 (reuses its repo-key). Supersedes the module-state location decisions in F1 (zone-2 module-state home), M1 (the registry's durable-cross-run home), M2 (the Docker registry path), and R1 (the config server's module-state path resolution) — those shipped specs are not edited; this entry is their cross-reference. Edits unimplemented O2. Adds no confinement-hook or permission-grant surface (module state is config-server-managed, so it lands in NO `~/.claude/settings.json` `permissions.allow` rule or `additionalDirectories` entry — the parity-MINUS vs F7's `--runs-dir`).
12. ✅ **A1** — loop & thrash detection. Shipped PR #27. *(Pure-logic + schema; made operative — the halt actually fires — by R7, see slot 15.)*
13. ✅ **[Q6](Q6-doc-lint-and-provenance.md)** — documentation enforcement: a framework doc-lint backing Q5's declared `docLintCmd` (export-doc presence gates; required-sections / commented-out-code advisory), a CI presence gate, and a comment / user-facing-string provenance judgment surface. Shipped PR #29.
14. ✅ **E5** — spec clarification phase. Shipped PR #30.
15. **Next. [R7](R7-runtime-invocation-bridge.md) — runtime invocation bridge.** ~3–4 sprints. **The keystone.** Because the orchestrator and agents run as markdown executed by Claude, they can call only what is exposed as an MCP tool or `gan` CLI subcommand — which today is the config server alone. The `trace`, `safety`, and `evaluator-core` libraries (T1, A1, E3) and the module helpers (M2 docker) are shipped, tested, and **uncallable from a markdown orchestrator**: real runs emit zero trace events, no loop-detection halt can fire, the evaluator cannot consume a deterministic plan, and the generator hand-rolls Docker instead of calling `PortRegistry`. R7 exposes those four library surfaces to the orchestrator and agents via MCP tools and/or `gan` shims, delegating to the already-tested functions. It does not edit the shipped T1/A1/E3/M2 specs — it is the cross-reference that makes them operative. Everything below depends on it.
16. **[E8](E8-independent-review-and-forced-verification.md) — independent adversarial review & forced verification.** ~4–5 sprints. **The headline.** Across v1.0 dogfooding to date the evaluator has rejected nothing (0 failing verdicts in 247), because by design it only scores pre-written contract criteria, runs the same model as the generator, and tolerates "minor issues" at the 7/10 bar — so contract-satisfying defects pass and a separate review agent reliably finds them afterward. E8 (a) adds a contract-free correctness/review pass (fresh context, a model distinct from the generator's) whose findings feed **contract renegotiation** so the existing evaluator gates on them — preserving the sole-gate rule rather than adding a second gate; (b) **forces** evaluator-core's plan (tests, lint, build, audit, secrets scan) to execute-and-parse through R7 rather than be reasoned about; (c) adds a general-correctness / no-new-defects criterion class not pinned to the contract; (d) recalibrates the correctness/security threshold off the 7/10 "minor issues OK" band. Supersedes the evaluator portions of E1/E3 via the new-spec mechanism (those shipped specs are not edited; this entry is their cross-reference). Pulls the *mechanism* of v2.0's V1 forward; the *measurement* of it stays in v2.0. Depends on R7.
17. **Docker module wiring.** ~1–2 sprints. Folds into R7's module arm + E8: the generator calls `PortRegistry` instead of inventing port logic, and the evaluator gates on real `ContainerHealth` ("the container actually boots"). Reconciles M2's explicitly-provisional API against a real agent call-graph — the existing Docker dogfood project is that call-graph. Depends on R7.
18. **[D1](D1-diagnostic-clarity.md)** — diagnostic clarity + SKILL.md status markers. ~2–3 sprints. Re-scoped: the "which sections are operative" audit runs **after** R7, so the markers reflect a bridge-wired runtime rather than aspirational prose.
19. **[D2](D2-prompt-hygiene.md) — prompt hygiene** (may fold into D1). ~1–2 sprints. De-verbose `SKILL.md` (collapse the three near-identical safety sections into one halt contract; drop the self-quotation), factor the boilerplate repeated verbatim across all six agent prompts into one shared preamble, and strip the internal `specifications/*` cross-references from the shipped product — which also closes the `lint-no-stack-leak` boundary those references currently violate. Pure clarity/precision; no behavioural change.
20. **[O1](O1-resolution-observability.md) + [O3](O3-telemetry-semantics.md) (minimal).** ~2 sprints. Full startup-log surface (O1) and the stderr cost/progress fuel-gauge (O3) — now backed by real trace data from R7. Parallelises with D1/D2.
21. **[O2](O2-recovery.md) (minimal recovery).** ~1–2 sprints. `--recover` becomes meaningful only once R7 makes the trace real; ship minimal trace-driven resume and defer the full recovery UX to v1.1. Depends on R7.
22. **[W1](W1-overlay-misuse-warnings.md)** — overlay-misuse warnings. ~2 sprints. In-flight; cheap; not trust-critical. Independent of the spine.
23. **Pre-release chores + release gate.** See below.

Independents within the order: slots 18–22 (D1, D2, O1/O3, O2, W1) hang off R7 (slot 15) but not off each other, so they parallelise once the bridge lands. E8 (slot 16) and Docker wiring (slot 17) are the critical path. The post-v1.0 dogfooding audit fires after slot 23.

### Known gaps accepted at v1.0

- **No automated end-to-end orchestrator-flow test.** v1.0 ships the *mechanism* for a trustworthy loop (R7 bridge + E8 independent review/forced verification) and proves it by dogfooding plus the release gate below; the automated harness that *measures* discriminator accuracy and variance is v2.0's scope (V1/V2/V3). Mechanism in v1.0, measurement in v2.0 — not the reverse.
- **Read surfaces over the trace are minimal.** R7 makes the trace real and O3 gives a stderr fuel-gauge, but the rich read CLIs (`gan run report` / `gan stats`) are v1.1 (T2). v1.0 users read trace files directly, per T1.
- **Per-stack overlay command override is a no-op.** Visible via W1's `PerStackOverrideUnsupported` warning; full implementation lands in v1.1.

### Pre-release chores and release gate

- **External-proof release gate.** v1.0 does not ship until `/gan` has been run end-to-end on at least one **non-self-hosting, ideally non-Node** project — the framework has only ever built its own TypeScript — and E8's independent review has caught **at least one real defect the contract criteria did not anticipate**. The existing Docker dogfood project is a second proof point. This gate is what converts "the gate can reject" from a design claim into demonstrated behaviour; without it the v1.0 trust story is unverified.
- **README v1.0 stack and module inventory.** Two README sections — "Stacks available in v1.0" (`web-node`, `generic`) and "Modules available in v1.0" (`docker`) — so users authoring an overlay don't have to read the C / M specs to discover what's available.

### Post-v1.0 dogfooding audit

Every v1.1 candidate spec is re-audited against trace data from v1.0 dogfooding before v1.1 work begins — trace data that is now real, because R7 made emission operative. Audit notes are authored when v1.0 ships; no v1.1 work starts until the audit closes. Same checkpoint discipline as the post-R, post-E1, post-M breaks.

Candidates seeded for this audit (judged against real traces, not designed speculatively now; gated behind the audit, not jumped ahead of the trace data):

- **Structural clone / prior-art detection surface (Q-series).** Flags when changed code duplicates code already present elsewhere in the repo OR in a prior sprint's diff within the same run. Motivated by the R6-era finding (`resolveUserHome` 3-way clone; `editedBody` cross-sprint dup). Shares Q1's diff-analysis substrate (natural ~v1.2); tokenized / structural and language-agnostic; advisory severity by default (per the "Measurement is separate from gating" convention in [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) § Conventions). Extends through E3's `evaluator.additionalChecks` as a pure function over (file content, file path, sprint plan).
- **Contract-time prior-art rule in the contract-proposer.** When the contract-proposer drafts a criterion introducing a utility / helper / constant, it searches the repo for an existing definition and, if found, writes a REUSE-OR-JUSTIFY-DIVERGENCE criterion the evaluator scores — turning cross-file duplication into a scored criterion before the generator runs. Proactive surface; pairs with the reactive clone probe above the way R6's scaffold guidance pairs with W1's `StackOverrideShrinkage` warning. Prompt-level change to the contract-proposer, NOT a new Config API surface. "Reuse or justify" (not "always reuse") so the generator can object when sharing is wrong.
- **Doc-lint advisory→blocker promotion (Q6 Part D).** Re-audit the two advisory `scripts/doc-lint/` rules shipped by [Q6](Q6-doc-lint-and-provenance.md) — **required-sections** and **commented-out-code** — against their false-positive rate observed across dogfooding runs (surfaced in run state by evaluator-core like every other doc finding). When a rule's FP rate is acceptable against the observed distribution, a follow-up PR flips that rule's default severity in `scripts/doc-lint/` from advisory to blocker (and, since it already runs in the Part B `test-doc-lint.yml` CI invocation, only its severity changes). Metric/trigger/owner/action are fixed contracts per Q6 Part D; the threshold is set by this audit, not guessed now.

## v1.1 — observe & control

Builds on real trace data (now flowing, post-R7) and v1.0 user reports. The theme is **observe and control**: rich read surfaces and operator steering over a loop that already bounds itself and can reject. Specs land in priority order driven by data, not speculation.

- **T2** — cost & efficiency read surface (`gan run report`, `gan stats`). The read CLI deferred from v1.0 now that the trace is real; the highest-frequency post-run need.
- **[H2](H2-operator-controls.md)** — operator controls: run halt + mid-run steering (`gan halt` / `resume` / `steer`). Extends H1's framework-owned confinement hook with a halt precedence check and adds a one-shot zone-2 steering channel. Depends on H1, A1, O2, T1; composes with A2 in the same hook (halt → scope → zone precedence). Steering is advisory only — it never alters contract criteria, preserving the evaluator's sole-gate property.
- **[A2](A2-generator-scope-enforcement.md)** — generator scope enforcement (PreToolUse hook, per-role scope splits).
- **U1 / U2 / U3 — overlay-UX polish** (moved from v1.0). The project-overlay, user-overlay, and additional-context surfaces. Real ergonomics, but not trust-critical — they make a trustworthy loop pleasant to configure, so they follow the core-loop work rather than gate the first release.
- **[O2](O2-recovery.md) — full recovery UX** (completes the minimal resume shipped in v1.0).
- **Deterministic secret scan** (from [ideas.md](ideas.md) #2). Promotes the evaluator's secrets check from glob-shape + LLM judgment to a real pattern scanner (gitleaks / trufflehog) run on the generated worktree through R7, emitting structured findings the evaluator includes verbatim. Pairs with A4's regex catalog; a direct hardening of the E8 gate.
- **Q2** — failure-mode taxonomy (structured error codes replacing free-form prose; shared vocabulary with E5's clarifier-gap codes).
  - *Evaluator-bundle follow-up — out-of-contract findings.* T1 pinned the evaluator's output to a per-criterion evidence bundle (`schemas/evaluator-evidence-bundle-v1.json`) and retired the legacy free-form `blockingConcerns[]` channel. Because every `criteria[].name` must satisfy the join-key invariant (it must match a criterion in the sprint contract), a genuinely *out-of-contract* finding — one that maps to no contract criterion — has no representation in the bundle. E8 (v1.0) makes this acute: the independent review pass produces exactly such findings. Q2 defines how orphan findings are surfaced — a structured out-of-contract record carried alongside the per-criterion verdicts, keyed by a Q2 error code (sharing the E5 clarifier-gap vocabulary) — plus the renegotiation-trigger semantics. Per T1's "additive stays on v1" rule this lands as a NEW OPTIONAL top-level bundle field (a field rename or a change to existing per-criterion semantics would instead force `evaluator-evidence-bundle-v2`). Surfaced by the post-merge review of T1; not a defect in T1 — a deferred design decision Q2 owns, now load-bearing for E8.
- **[T4](T4-run-configuration-record.md)** — run-configuration trace record. A per-run `runConfiguration` event (framework version, config digest, active stacks, agent roster + per-role model, trust posture, resolved harness knobs) for run-level debugging and V1's cross-run comparison. Additive new event class on `run-trace-v1`. Now also records E8's reviewer model, distinct from the generator's.
- **A4** — PII / secret regex catalog (per-stack regex bank layered on `secretsGlob`; the data behind the deterministic secret scan above).
- **E5 round 2** — confidence-scored adaptive clarification depth; optional persistence of resolved clarifications to `additionalContext`.
- **Per-stack overlay command override completion** — closes W1's `PerStackOverrideUnsupported` warning with the real implementation.
- **Schema-runtime alignment via generation or contract tests** — closes F5's surgical fix with the structural one.
- **F6 → trust-prompt enforcement (new spec).** Builds on F6's documentation baseline with server-side enforcement options: rate-limiting, content-hash echo, structured audit log, scoped capability tokens (per F4's `[deferred-to-v1.1]` markers). The R7 bridge widens the command-execution surface, so this enforcement work is more load-bearing post-R7.
- **`getMergedSplicePoints` inclusion-rule documentation (new spec).** Defines which fields participate; reserved fields like `stack.override` surface elsewhere.
- **Stack-file naming convention (new spec).** Publishes one rule for stack-file names; matters once `gan stacks list` has 5+ entries.

## v1.2 — enforce & reproduce

Requires production usage data the v1.0 → v1.1 cycle produces. The theme is **enforce and reproduce**: budget ceilings, destructive-action guards, and reproducible verdicts that harden the E8 gate against drift.

- **Q1** — diff acceptance feedback loop (`.gan-state/feedback/`; per-stack acceptance/churn/revert rates).
- ✅ **Q5** — documentation-quality enforcement. Two new optional stack-schema fields source a project's documentation standard from config (`documentationSurfaces`, instantiated as gating contract criteria via C1's template-instantiation protocol exactly like `securitySurfaces`; `docLintCmd`, a deterministic baseline-relative doc-lint run by evaluator-core), enforced in three layers (default stack convention, deterministic lint, evaluator-scored gating criteria) with the per-rule gates-vs-warns split on the deterministic layer. Supersedes/extends C1 (schema), E1/E2 (proposer + evaluator prompts), and E3 (evaluator-core) via the new-spec mechanism; those shipped specs are not edited — this entry is their cross-reference. Shipped PR #25. Extended by [Q6](Q6-doc-lint-and-provenance.md) (#29), which delivers Q5's deferred `docLintCmd` tool + a CI presence gate + a comment-provenance `documentationSurfaces` entry.
- **A3** — framework-owned destructive-action guard.
- **A5** — LLM-sampling reproducibility on verdict roles (pinned temperature/seed on the evaluator, the E8 review agent, and the contract-reviewer). Directly stabilises the E8 gate: a verdict that flips run-to-run on the same input is the failure mode A5 closes.
- **[E6](E6-pluggable-evaluator-role.md)** — pluggable evaluator role (swap LLM evaluator for a human reviewer at the same contract boundary). Natural extension of E8's independent-review seam: E8 makes the review role pluggable in principle; E6 makes a human one of the options.
- **T3** — budget enforcement (per-run token / $ ceilings; lights up A1's reserved `tokenBudgetExceeded` / `wallClockBudgetExceeded` halt discriminators, which became fireable once R7 wired the safety layer).

## v2.0 — measure the agents

From "framework that runs agents" to "framework that *measures* agents." Depends on v1.x usage shape. By v2.0 the gate already rejects (E8, v1.0); v2.0 quantifies *how well* it rejects and hardens it with variance budgets and adversarial traps — measurement of a working mechanism, not the introduction of one.

- **V1** — LLM-verdict accuracy harness with confidence-calibration. **Measures and tunes the E8 discriminator that v1.0 already ships** (rather than introducing gating for the first time): how often does the independent review agree with ground truth, and where should the thresholds sit? Promotes the optional accuracy check (E4) to gating, and is the automated end-to-end orchestrator-flow harness named as a known gap at v1.0.
- **V2** — variance budget (same input × M samples; agreement-rate per criterion class). Quantifies the run-to-run stability A5 started pinning.
- **V3** — adversarial trap suite + planted-trap fixtures per stack. Directly scores whether E8's review catches deliberately-planted defects — the systematic version of v1.0's one-defect release gate.
- **B1** — SWE-bench Verified integration (nightly).
- **B2** — in-house regression set from real v1.x usage.
- **Q3** — coverage delta tracking (per-stack `coverageCmd` + threshold splice point).
- **Q4** — per-stack repo-convention checks (`conventionCmd` slot).
- **E7** — browser-verified evaluator (new spec). The evaluator opens the running app through a browser surface and scores UI from what it observes, instead of trusting generator-reported screenshots; injects browser checks into E3's evaluator-core through the existing `evaluator.additionalChecks` / stack splice points, paired with a frontend stack. Prerequisite for a graded design-quality rubric (the Q-series quality signal — gradable subjective quality, not binary pass/fail).
- **C6** — per-step model routing in stack files (tiered model selection per agent role). Generalises E8's generator-vs-reviewer model split into per-role routing configurable by stack.

## Beyond v2.0

- **B3** — TerminalBench / Aider polyglot integration (gated on deferred S-series stacks landing).
- **Deferred S-series stacks** — Android, KMP, iOS Swift per [`specifications/deferred/README.md`](deferred/README.md).
- **Additional real-ecosystem stacks** — desktop, embedded, Python, Rust, Go follow the same template.
- **Q7 — multi-stack doc-lint language profiles** (from [ideas.md](ideas.md) #3). Generalise Q6's TypeScript-only doc-lint to other languages via a declarative `LanguageProfile` (data) plus a neutral core (library), never stack-injected executable code. Extract against the second real language, not before — factoring an abstraction from one example bakes in TS assumptions.
- **U4 — external spec sources (`--spec <url>`)** (from [ideas.md](ideas.md) #1). Fetch a Jira / GitHub / Linear issue or URL as the spec input via installed MCPs, persisted to run state so recovery stays deterministic.
- **Post-run external documentation generation** (from [ideas.md](ideas.md) #4). Optional per-stack documentation module that emits/updates external markdown + mermaid architecture docs incrementally from a run's diff, resolved through the overlay cascade and structurally gated (mermaid parses; every node/edge references a symbol that still exists).
- **Plugin marketplace + share/install flow** — gated on stable plugin/skill formats (v1.0) and survivable trust model (F4 + capability tokens, v1.1).

## Branch strategy

Branches and worktrees are cut from `develop` and named `feature/<spec-name>` after the spec they implement (e.g. `feature/f5-config-api-coherence`). Implementation work merges back to `develop`; `develop` merges to `main` at release boundaries (v1.0, v1.1, v1.2, v2.0). `main` never carries a partially-built release.

## Out of scope for this roadmap

- **Cross-run learning / auto-curated project memory.** `/gan` stays a reader of documented overlay files; it never writes durable project knowledge *unless* the user explicitly confirms promotion (e.g. E5 v1.1's offer to save resolved clarifications as project-tier `additionalContext`). The framework never auto-curates; the user always confirms.
- **Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery.** Users opt in explicitly via `additionalContext` (U3).
- **Real-ecosystem stacks beyond `web-node` pre-v2.0.** The deferred S-series specs (Android, KMP, iOS Swift) capture a starting point; reactivation is gated by the criteria in [`specifications/deferred/README.md`](deferred/README.md). Desktop and embedded stacks follow the same template if and when the pattern is proven on a second real ecosystem.
- **Cross-language benchmarking pre-v2.0.** B3 (TerminalBench / Aider polyglot) waits for real cross-language stacks to exist.

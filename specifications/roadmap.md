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

**Goal:** ship a usable product to early users so design assumptions get tested against real prompts, real codebases, and real failures.

**User experience target:** a developer installs ClaudeAgents, edits `.claude/gan/project.md` to declare their project's quirks, runs `/gan` with a prompt, gets bounded clarifying questions on genuine ambiguities, sees a startup log naming active stacks (with non-aborting warnings on overlay misuse), gets a sprint plan/contract/generation/evaluation cycle that won't loop forever, can `--recover` if interrupted, and can read a structured trace afterward.

**Effort estimate:** ~27–34 sprints of focused work (~7–9 calendar months at one full-time developer).

### Implementation order

The numbered list below IS the v1.0 spec inventory. Each entry is one line: spec link, position rationale, dependencies. Spec content lives in the spec files.

1. ✅ **M3** — module surface alignment. Shipped PR #8.
2. ✅ **I1** — self-contained install correctness. Shipped PR #9.
3. ✅ **I3** — uninstall + version policy. Shipped PR #9 (slices 1+3) and PR #10 (slice 2).
4. ✅ **I2** — install user-facing surfaces. Shipped PR #13.
5. ✅ **F5** — config API surface coherence. Shipped PR #14.
6. ✅ **R6** — tier-aware stack scaffold. Shipped PR #16.
7. ✅ **F6** — trust-prompt protocol clarification. Shipped PR #18.
8. ✅ **T1** — structured run trace. Shipped PR #19. *(Run-data and trace location relocated to the central store by F7 — see slot 10.)*
9. ✅ **H1** — framework-owned confinement hook. Shipped PR #21. *(Hook path construction superseded by F7 — see slot 10.)*
10. ✅ **F7** — centralized run-data store + worktree-aware execution. Shipped PR #23. Relocates run data to a central, repo-keyed store (`~/.gan-runs-data`) so it survives worktree removal; makes `/gan` reuse a task worktree in place (1a/1b/1c). Supersedes the run-data/trace location in F1/T1 and the confinement-hook path construction in H1 (those shipped specs are not edited; this entry is their cross-reference). Edits unimplemented O2/O3 and draft H2. Lands before A1/E5/O2/O3 so run paths and confinement are settled before those build on them.
11. **[F8](F8-centralized-module-state-store.md)** — centralized repo-keyed module-state store. ~2–3 sprints. Pairs with F7 (the same zone-2 worktree-removal fix, for module state): relocates `.gan-state/modules/` to a separate repo-keyed store, fixing both the durability footgun and a latent M2 cross-worktree port-collision bug. Depends on F7 (reuses its repo-key); ships in the same PR. Supersedes F1/M1/M2/R1 location decisions; edits unimplemented O2; adds no confinement-hook or permission-grant surface (module state is config-server-managed).
12. **[A1](A1-loop-and-thrash-detection.md)** — loop & thrash detection. ~3–4 sprints. Depends on T1.
13. **[E5](E5-spec-clarification.md)** — spec clarification phase. ~3–4 sprints. Depends on T1; can run in parallel with A1.
14. **[W1](W1-overlay-misuse-warnings.md)** — overlay-misuse warnings. ~2 sprints. Independent of A1/E5.
15. **[D1](D1-diagnostic-clarity.md)** — diagnostic clarity. ~2–3 sprints. SKILL.md status markers depend on knowing which v1.0 sections are operative — lands after A1, E5.
16. **[O3](O3-telemetry-semantics.md)** — telemetry semantics. ~2–3 sprints. Depends on T1 and F7; can run in parallel with W1, D1.
17. **O1 / O2 / U1 / U2 / U3** — polish on existing primitives (full O1 surface, O2 implementation, the three overlay-UX specs). ~2–3 sprints across all five.
18. **Pre-release chores.** See below.

Independents within the order: slots 8–16 have the dependency relationships called out above; F6 (slot 7, documentation-only) gates nothing. The post-v1.0 dogfooding audit fires after slot 18.

### Known gaps accepted at v1.0

- **No CI test for end-to-end orchestrator flow.** v1.0 dogfooding is the implicit test surface; the orchestrator-side test harness is v2.0 V1's scope.
- **Per-stack overlay command override is a no-op.** Visible via W1's `PerStackOverrideUnsupported` warning; full implementation lands in v1.1.

### Pre-release chores

- **README v1.0 stack and module inventory.** Two README sections — "Stacks available in v1.0" (`web-node`, `generic`) and "Modules available in v1.0" (`docker`) — so users authoring an overlay don't have to read the C / M specs to discover what's available.

### Post-v1.0 dogfooding audit

Every v1.1 candidate spec is re-audited against T1 trace data from v1.0 dogfooding before v1.1 work begins. Audit notes are authored when v1.0 ships; no v1.1 work starts until the audit closes. Same checkpoint discipline as the post-R, post-E1, post-M breaks.

Candidates seeded for this audit (judged against real T1 traces, not designed speculatively now; gated behind the audit, not jumped ahead of T1):

- **Structural clone / prior-art detection surface (Q-series).** Flags when changed code duplicates code already present elsewhere in the repo OR in a prior sprint's diff within the same run. Motivated by the R6-era finding (`resolveUserHome` 3-way clone; `editedBody` cross-sprint dup). Shares Q1's diff-analysis substrate (natural ~v1.2); tokenized / structural and language-agnostic; advisory severity by default (per the "Measurement is separate from gating" convention in [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) § Conventions). Extends through E3's `evaluator.additionalChecks` as a pure function over (file content, file path, sprint plan).
- **Contract-time prior-art rule in the contract-proposer.** When the contract-proposer drafts a criterion introducing a utility / helper / constant, it searches the repo for an existing definition and, if found, writes a REUSE-OR-JUSTIFY-DIVERGENCE criterion the evaluator scores — turning cross-file duplication into a scored criterion before the generator runs. Proactive surface; pairs with the reactive clone probe above the way R6's scaffold guidance pairs with W1's `StackOverrideShrinkage` warning. Prompt-level change to the contract-proposer, NOT a new Config API surface. "Reuse or justify" (not "always reuse") so the generator can object when sharing is wrong.

## v1.1 — first iteration on real signal

Builds on T1 trace data and v1.0 user reports. Specs land in priority order driven by data, not speculation.

- **[A2](A2-generator-scope-enforcement.md)** — generator scope enforcement (PreToolUse hook, per-role scope splits).
- **[H2](H2-operator-controls.md)** — operator controls: run halt + mid-run steering (`gan halt` / `resume` / `steer`). Extends H1's framework-owned confinement hook with a halt precedence check and adds a one-shot zone-2 steering channel. Depends on H1, A1, O2, T1; composes with A2 in the same hook (halt → scope → zone precedence). Steering is advisory only — it never alters contract criteria, preserving the evaluator's sole-gate property.
- **Q2** — failure-mode taxonomy (structured error codes replacing free-form prose; shared vocabulary with E5's clarifier-gap codes).
  - *T1 follow-up — out-of-contract findings have no home in the evaluator evidence bundle.* T1 pinned the evaluator's output to a per-criterion evidence bundle (`schemas/evaluator-evidence-bundle-v1.json`) and retired the legacy free-form `blockingConcerns[]` channel. Because every `criteria[].name` must satisfy the join-key invariant (it must match a criterion in the sprint contract), a genuinely *out-of-contract* finding — one that maps to no contract criterion — has no representation in the bundle, and the contract-renegotiation trigger silently shifted from "non-empty `blockingConcerns`" to "any `blocked` verdict." Q2 should define how orphan findings are surfaced: a structured out-of-contract record carried alongside the per-criterion verdicts and keyed by a Q2 error code (sharing the E5 clarifier-gap vocabulary), plus an explicit definition of the renegotiation-trigger semantics. Per T1's "additive stays on v1" rule this lands as a NEW OPTIONAL top-level bundle field (a field rename or a change to existing per-criterion semantics would instead force `evaluator-evidence-bundle-v2`). Surfaced by the post-merge review of T1's implementation; not a defect in T1 (the bundle shape is deliberate) — a deferred design decision Q2 owns.
- **T2** — cost & efficiency surface (`gan run report`, `gan stats`).
- **[T4](T4-run-configuration-record.md)** — run-configuration trace record. A per-run `runConfiguration` event (framework version, config digest, active stacks, agent roster + per-role model, trust posture, resolved harness knobs) for run-level debugging and V1's cross-run comparison. Additive new event class on `run-trace-v1`.
- **A4** — PII / secret regex catalog (per-stack regex bank layered on `secretsGlob`).
- **E5 round 2** — confidence-scored adaptive clarification depth; optional persistence of resolved clarifications to `additionalContext`.
- **Per-stack overlay command override completion** — closes W1's `PerStackOverrideUnsupported` warning with the real implementation.
- **Schema-runtime alignment via generation or contract tests** — closes F5's surgical fix with the structural one.
- **F6 → trust-prompt enforcement (new spec).** Builds on F6's documentation baseline with server-side enforcement options: rate-limiting, content-hash echo, structured audit log, scoped capability tokens (per F4's `[deferred-to-v1.1]` markers).
- **`getMergedSplicePoints` inclusion-rule documentation (new spec).** Defines which fields participate; reserved fields like `stack.override` surface elsewhere.
- **Stack-file naming convention (new spec).** Publishes one rule for stack-file names; matters once `gan stacks list` has 5+ entries.

## v1.2 — quality signal

Requires production usage data the v1.0 → v1.1 cycle produces.

- **Q1** — diff acceptance feedback loop (`.gan-state/feedback/`; per-stack acceptance/churn/revert rates).
- **A3** — framework-owned destructive-action guard.
- **A5** — LLM-sampling reproducibility on verdict roles (pinned temperature/seed on evaluator + contract-reviewer).
- **[E6](E6-pluggable-evaluator-role.md)** — pluggable evaluator role (swap LLM evaluator for a human reviewer at the same contract boundary).
- **T3** — budget enforcement (per-run token / $ ceilings; lights up A1's reserved `tokenBudgetExceeded` / `wallClockBudgetExceeded` halt discriminators).

## v2.0 — agent evaluation

From "framework that runs agents" to "framework that *measures* agents." Depends on v1.x usage shape.

- **V1** — LLM-verdict accuracy harness with confidence-calibration dimension. Promotes E4 from optional to gating.
- **V2** — variance budget (same input × M samples; agreement-rate per criterion class).
- **V3** — adversarial trap suite + planted-trap fixtures per stack.
- **B1** — SWE-bench Verified integration (nightly).
- **B2** — in-house regression set from real v1.x usage.
- **Q3** — coverage delta tracking (per-stack `coverageCmd` + threshold splice point).
- **Q4** — per-stack repo-convention checks (`conventionCmd` slot).
- **E7** — browser-verified evaluator (new spec). The evaluator opens the running app through a browser surface and scores UI from what it observes, instead of trusting generator-reported screenshots; injects browser checks into E3's evaluator-core through the existing `evaluator.additionalChecks` / stack splice points, paired with a frontend stack. Prerequisite for a graded design-quality rubric (the Q-series quality signal — gradable subjective quality, not binary pass/fail).
- **C6** — per-step model routing in stack files (tiered model selection per agent role).

## Beyond v2.0

- **B3** — TerminalBench / Aider polyglot integration (gated on deferred S-series stacks landing).
- **Deferred S-series stacks** — Android, KMP, iOS Swift per [`specifications/deferred/README.md`](deferred/README.md).
- **Additional real-ecosystem stacks** — desktop, embedded, Python, Rust, Go follow the same template.
- **Plugin marketplace + share/install flow** — gated on stable plugin/skill formats (v1.0) and survivable trust model (F4 + capability tokens, v1.1).

## Branch strategy

Branches and worktrees are cut from `develop` and named `feature/<spec-name>` after the spec they implement (e.g. `feature/f5-config-api-coherence`). Implementation work merges back to `develop`; `develop` merges to `main` at release boundaries (v1.0, v1.1, v1.2, v2.0). `main` never carries a partially-built release.

## Out of scope for this roadmap

- **Cross-run learning / auto-curated project memory.** `/gan` stays a reader of documented overlay files; it never writes durable project knowledge *unless* the user explicitly confirms promotion (e.g. E5 v1.1's offer to save resolved clarifications as project-tier `additionalContext`). The framework never auto-curates; the user always confirms.
- **Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery.** Users opt in explicitly via `additionalContext` (U3).
- **Real-ecosystem stacks beyond `web-node` pre-v2.0.** The deferred S-series specs (Android, KMP, iOS Swift) capture a starting point; reactivation is gated by the criteria in [`specifications/deferred/README.md`](deferred/README.md). Desktop and embedded stacks follow the same template if and when the pattern is proven on a second real ecosystem.
- **Cross-language benchmarking pre-v2.0.** B3 (TerminalBench / Aider polyglot) waits for real cross-language stacks to exist.

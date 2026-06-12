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

## Schema-versioning ruling (pre-v1.0)

A conflict surfaced during E8 review: PROJECT_CONTEXT § "Schema discipline" says *"pre-v1.0, any schema change bumps `schemaVersion`"*, while the shipped schema documents' own descriptions (`run-trace-v1`, `evaluator-evidence-bundle-v1`) say additive changes stay on `vN`. They disagree — and E8, Q2, and the v1.1 per-stack-override work all need the answer before they touch a schema.

**Ruling — additive-stays-`vN`, grounded in lived precedent.** A1 added the `safetyHalt` event class to the shipped `run-trace-v1.json` with **no** `run-trace-v2` and no migration tool; that is the practiced rule. So, pre-v1.0:

- **Additive** changes — a new optional field, a new enum/discriminator value, a new event class — edit the `vN` file **in place**: no version bump, no migration tool. (Pre-v1.0 there is no released consumer to migrate; "no backward-compatibility shims" means we change freely, not that every field forks a version.)
- **Breaking** changes — a field rename or a semantic change to an existing field — force `vN+1` with the migration tool, exactly as PROJECT_CONTEXT's Don'ts require.

This is what E8 relies on (overlay `renegotiationCap`, `run-trace` `contractRevision`, both additive-in-place) and what Q2's evidence-bundle field (v1.1) will. **Folded into PROJECT_CONTEXT § "Schema discipline" — done.** PROJECT_CONTEXT previously said *"pre-v1.0, any schema change bumps `schemaVersion`"* (reinforced in the Don'ts), which would have forced `run-trace`→v2 and `overlay`→v2 and broken E8's hard requirement plus the shipped `evaluator-evidence-bundle-v1` join key. That clause is now replaced with this additive-stays-`vN` ruling and the contradicting Don'ts sentences removed, so the authority doc and the v1.0 specs agree. **PROJECT_CONTEXT § "Schema discipline" is the operative home;** this section records the rationale and the A1 `safetyHalt` precedent.

## Shipped

Phases 0–4 (foundations F1–F4; configuration domains C1–C5; reference implementation R1–R5; agent integration E1–E3; modules M1–M3) have shipped. See the spec files in `specifications/` for the contract each one carries. v1.0 items already merged are marked ✅ in the implementation order below.

## v1.0 — first release

**Goal:** ship a product whose output a user can *trust* — a loop that can actually reject bad code — to early users, so design assumptions get tested against real prompts, real codebases, and real failures. The release test for every item: *does it make the code the framework emits more trustworthy?* If an item does not, it is not a v1.0 item.

**User experience target:** a developer installs ClaudeAgents, edits `.claude/gan/project.md` to declare their project's quirks, runs `/gan` with a prompt, gets bounded clarifying questions on genuine ambiguities, sees a startup log naming active stacks (with non-aborting warnings on overlay misuse), and gets a plan/contract/generation/evaluation cycle that won't loop forever (the safety layer actually fires), is independently reviewed for defects the contract never anticipated (the gate can reject, not just rubber-stamp), emits a real structured trace they can read, and can `--recover` if interrupted.

**Effort estimate:** ~34–45 sprints of focused work (~9–11 calendar months at one full-time developer) — ~32–42 for the spec implementations **plus a ~2–3 sprint external-proof release-gate workstream** (standing up the non-Node dogfood target and *running* the protocol; owned and resourced from the *start* of the release, not discovered at the freeze — see "Pre-release chores and release gate" below). The calibrated planted-defect suite the gate exercises is **authored in E8's PR** (inside the ~32–42), not a separate gate-built artifact — so the gate workstream is the target plus the run, not the suite. The earlier headline excluded the gate workstream even though it is the single highest-risk item; it is now folded in. The two largest new specs — R7 (runtime bridge) and E8 (independent review + forced verification) — are roughly a third of the implementation work and sit on the critical path (M4, the third new spec, is a small off-critical-path prompt rewrite); the overlay-UX polish (U1/U2/U3) moves to v1.1 to make room for them.

### Implementation order

The numbered list below is the v1.0 spec inventory, in execution order. Each entry is a one-line spec link (shipped entries add the PR); dependencies, effort, and rationale live in the spec files.

1. ✅ **[M3](M3-module-surface-alignment.md)** — module surface alignment. Shipped PR #8.
2. ✅ **[I1](I1-self-contained-install-correctness.md)** — self-contained install correctness. Shipped PR #9.
3. ✅ **[I3](I3-uninstall-and-version-policy.md)** — uninstall + version policy. Shipped PR #9 + #10.
4. ✅ **[I2](I2-install-user-facing-surfaces.md)** — install user-facing surfaces. Shipped PR #13.
5. ✅ **[F5](F5-config-api-coherence.md)** — config API surface coherence. Shipped PR #14.
6. ✅ **[R6](R6-tier-aware-stack-scaffold.md)** — tier-aware stack scaffold. Shipped PR #16.
7. ✅ **[F6](F6-trust-prompt-protocol-clarification.md)** — trust-prompt protocol clarification. Shipped PR #18.
8. ✅ **[T1](T1-structured-run-trace.md)** — structured run trace. Shipped PR #19.
9. ✅ **[H1](H1-framework-owned-confinement-hook.md)** — framework-owned confinement hook. Shipped PR #21.
10. ✅ **[F7](F7-central-run-data-store-and-worktree-execution.md)** — centralized run-data store + worktree-aware execution. Shipped PR #23.
11. ✅ **[F8](F8-centralized-module-state-store.md)** — centralized repo-keyed module-state store. Shipped PR #24.
12. ✅ **[Q5](Q5-documentation-quality-enforcement.md)** — documentation-quality enforcement. Shipped PR #25.
13. ✅ **[A1](A1-loop-and-thrash-detection.md)** — loop & thrash detection. Shipped PR #27.
14. ✅ **[Q6](Q6-doc-lint-and-provenance.md)** — doc-lint enforcement + comment/string provenance. Shipped PR #29.
15. ✅ **[E5](E5-spec-clarification.md)** — spec clarification phase. Shipped PR #30.
16. ✅ **[W1](W1-overlay-misuse-warnings.md)** — overlay-misuse warnings. Shipped PR #31.
17. ✅ **[D2](D2-prompt-hygiene.md)** — prompt hygiene. Shipped PR #33.
18. ✅ **[R7](R7-runtime-invocation-bridge.md)** — runtime invocation bridge. Shipped PR #34.
19. ✅ **[E8](E8-independent-review-and-forced-verification.md)** — independent adversarial review & forced verification. Shipped PR #35.
20. ✅ **[M4](M4-docker-module-wiring.md)** — Docker module wiring. Shipped PR #36.
21. ✅ **[O2](O2-recovery.md)** — minimal recovery. Shipped PR #37.
22. ✅ **[O1](O1-resolution-observability.md)** — resolution observability. Shipped PR #38.
23. ✅ **[O3](O3-telemetry-semantics.md)** — telemetry semantics. Shipped PR #39.
24. ✅ **[D1](D1-diagnostic-clarity.md)** — diagnostic clarity + SKILL.md status markers. Shipped PR #40.

**Structural-audit hotfix set (2026-06-12).** The audit ([`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md)) traced the first-sprint review failures to a stale confinement-hook allowlist, an unwired first-pass contract review, and the prose-only-enforcement cluster the bug-report corpus documented. These eight items are v1.0-blocking — the release gate cannot run a protocol the loop cannot complete — and land before the pre-release chores, in this order:

25. **Next.** **[H4](H4-confinement-hook-artifact-parity.md)** — confinement-hook artifact parity + run-artifact catalog. Unbreaks `/gan`; no dependencies.
26. **E9** — contract quality gate (BR-006/BR-007). Spec and implementation in flight on `feature/fix-order-plan-tier5-impl` (the spec file lands on `develop` with that branch); review, rebase onto post-H4 develop, land. Includes the BR-013/BR-015 close-outs.
27. **[E11](E11-agent-tool-grant-coherence.md)** — agent tool-grant & caller coherence + `web-node` `lintCmd` repair. Parallel-safe with 26.
28. **[E10](E10-contract-review-wiring-and-negotiation-budget.md)** — first-pass contract-review wiring + negotiation budget. Depends on E9, H4.
29. **[F9](F9-run-artifact-write-boundary.md)** — schema-gated run-artifact write boundary (closes the BR-001/002/003/005/016 cluster). Depends on H4, E10.
30. **[O4](O4-run-store-lock-and-recovery-hardening.md)** — run-store, lock & recovery hardening. Slice 1 parallel-safe; slice 2 depends on F9.
31. **[Q8](Q8-repo-gate-honesty.md)** — repo-gate honesty: CI gating, API-surface parity, prompt-surface parity lints. Depends on H4, E11.
32. **[D3](D3-skill-executable-surface-reduction.md)** — SKILL.md executable-surface reduction. Depends on E10, F9, O4; lands last.
33. **Pre-release chores + release gate.** See below.

### Known gaps accepted at v1.0

- **No automated end-to-end orchestrator-flow test.** v1.0 ships the *mechanism* for a trustworthy loop (R7 bridge + E8 independent review/forced verification) and proves it by dogfooding plus the release gate below; the automated harness that *measures* discriminator accuracy and variance is v2.0's scope (V1/V2/V3). Mechanism in v1.0, measurement in v2.0 — not the reverse.
- **Read surfaces over the trace are minimal.** R7 makes the trace real and O3 gives a stderr fuel-gauge, but the rich read CLIs (`gan run report` / `gan stats`) are v1.1 (T2). v1.0 users read trace files directly, per T1.
- **The safety layer's *obedience* is mechanism-present, behaviour-unverified.** R7 makes the loop-detection checks callable and SKILL.md instructs the orchestrator to halt on a halt verdict — but the orchestrator is Claude executing markdown, which *can* ignore an instruction. CI proves (tool-level) that the check is called and returns the right decision; it cannot prove a real run actually stops. "Won't loop forever" is therefore mechanism-verified, behaviour-verified only by the release-gate dogfood + V1 (v2.0). Same class as the orchestrator-flow-test gap above.
- **Downstream correctness compounds on trace-emission fidelity (same root as the safety-obedience gap).** O2's recovery counter reconstruction, E8's revision-scoped budget (§ "Bounding thrash"), and O3's cost rollup all *read* the trace — so each silently degrades or mis-fires if the markdown orchestrator skips an `emitTraceEvent` call. R7 makes emission a tool and CI proves the tool works and is called at the documented SKILL.md points; that a *real run* emits every event is behaviour-verified only by the release-gate dogfood, not CI. Same class as the safety-obedience gap — flagged here because three downstream specs compound on it.
- **Per-stack overlay command override is not supported.** A `<stack>.buildCmd` / `testCmd` / `lintCmd` / `auditCmd` block in an overlay is rejected by the overlay schema (`overlay-v1.json` is `additionalProperties: false` and has no per-stack block — those fields live only in the stack schema), so it surfaces as a `SchemaMismatch` validation error today, not a silent no-op. An earlier W1 draft planned a `PerStackOverrideUnsupported` warning for this and it was cut before shipping (false premise — see W1 § "Deferred: per-stack command-override warning"). Real support lands in v1.1.

### Pre-release chores and release gate

- **External-proof release gate — the single highest-risk, least-automatable item; a resourced ~2–3 sprint workstream, not a chore (now folded into the effort estimate above).** Because the orchestrator is markdown-run-by-Claude and CI has no LLM, **no automated test proves the end-to-end loop works** (see Known gaps). The release therefore gates on a **structured dogfood protocol**, planned and resourced from the *start* of the release, not discovered at the freeze:
  1. `/gan` runs clean end-to-end on at least one **non-self-hosting, ideally non-Node** project (the framework has only ever built its own TypeScript plus a Docker dogfood);
  2. against the **calibrated planted-defect suite** (the same set E8's defect-catch floor uses), E8's independent review surfaces and the gate **rejects** a defined fraction of real, contract-unanticipated defects — *demonstrated*, not asserted;
  3. trace emission, a loop-detection **halt actually firing**, and a `--recover` resume are each **observed** on a real run (this is the only proof of the "safety obedience" and "trace operative" gaps above).

  **The gate workstream — owned and estimated up front (not found artifacts discovered at the freeze) — ~2–3 sprints total, included in the effort estimate above:**
  - **A non-Node dogfood target (~1–2 sprints)** — a real, non-self-hosting project in a non-Node ecosystem to satisfy item 1. The framework has only ever built its own TypeScript plus a Docker dogfood, so this target does not exist yet; standing it up (choosing the ecosystem, wiring its `web-node`-analogue or `generic`-stack run, getting `/gan` to complete on it) is itself engineering work with a named owner, not a checkbox at freeze.
  - **Running and observing the protocol (~1 sprint)** — driving items 1–3 on the stood-up target.
  - **The calibrated planted-defect suite is *not* a gate build-cost — it ships in E8's PR** (E8 § "Release-gate", inside the ~32–42 spec estimate): E8 authors and **calibrates it against `web-node`** and pins the defect-catch floor; the gate **runs** that suite against the live loop (item 2), it does not rebuild it. Single owner — E8 builds, the gate consumes; V3 (v2.0) later systematizes it per stack.

  **Stack caveat (gate scope).** A *non-Node* run (item 1) exercises E8's **contract-free reviewer** — the LLM judgment — and proves the framework operates cross-ecosystem, but **not** forced deterministic verification: only `web-node` ships real build/test/lint/audit commands; `generic` has none for E8 to execute. So the planted-defect suite (item 2) runs on **`web-node`** to prove forced execution *and* rejection, while the non-Node run proves reach plus the reviewer. v1.0 ships no second verification-capable stack — this split is the honest gate scope, stated rather than papered over.

  This converts "the gate can reject" and "won't loop forever" from design claims into evidence. It is make-or-break for v1.0 credibility: **if the protocol does not pass, v1.0 does not ship.**
- **README v1.0 stack and module inventory.** Two README sections — "Stacks available in v1.0" (`web-node`, `generic`) and "Modules available in v1.0" (`docker`) — so users authoring an overlay don't have to read the C / M specs to discover what's available.
- **Install-version bump discipline (every install-affecting spec).** `install.sh` re-runs `npm install -g .` — the step that re-links the config server, its bundled `schemas/`, and the `gan` CLI — **only when `package.json`'s `version` differs from the installed server's** (`version_probe_mcp`); agent and `SKILL.md` content is copied on every run regardless. So any spec whose implementation changes the **installed package** — a new/changed MCP tool, a bundled `schemas/*.json`, or `gan`/server-binary behaviour — **MUST minor-bump `package.json` `version` in its implementation PR** — a *minor* increment (`0.MINOR.0`, e.g. `0.1.0` → `0.2.0`), with patch reserved for fixes within a version — or a dogfooding user who `git pull`s and re-runs `install.sh` keeps the *old* server and must uninstall-then-install to recover. Prompt-only specs (agent / `SKILL.md` edits) don't bump. This is the framework `package.json` version — **distinct from** per-schema `schemaVersion` (the additive-stays-v`N` ruling above). Each affected v1.0 spec states its bump in its own text; **flagged for the spec-validator** to fold the rule into PROJECT_CONTEXT § Conventions (its permanent home). Unlike the schema-versioning fold above, this is an **additive** fold — it contradicts nothing in PROJECT_CONTEXT today — so it is *pending*, not an E8 blocker.
- **Final prompt-hygiene re-check (covers D2's early-landing residual).** D2 lands first and its lints — the house-rules named-region parity check (against the source partial outside `agents/`) and `lint-no-spec-ref` — keep the *structural* format through every later SKILL.md edit (E8/D1/O2/O1/O3). The one thing no lint catches is subjective prose verbosity in the content those specs add afterward. So before release, a reviewer re-reads the assembled `SKILL.md` + agent prompts against D2's format (no re-introduced rationale or self-quotation, the halt-contract still single, sections terse) — a diff-scoped read-through, not a re-refactor. This substitutes for the "D2 runs last" guarantee that landing it early trades away.

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
- ✅ **[H3](H3-stale-project-hook-detection-and-migration.md)** — Stale project-tier confinement hook detection and migration. Shipped PR #<n>. Addresses the migration gap H1 flagged abstractly and F7 made concrete.
- **[A2](A2-generator-scope-enforcement.md)** — generator scope enforcement (PreToolUse hook, per-role scope splits).
- **U1 / U2 / U3 — overlay-UX polish** (moved from v1.0). The project-overlay, user-overlay, and additional-context surfaces. Real ergonomics, but not trust-critical — they make a trustworthy loop pleasant to configure, so they follow the core-loop work rather than gate the first release.
- **[O2](O2-recovery.md) — full recovery UX** (completes the minimal resume shipped in v1.0).
- **Deterministic secret scan** (from [ideas.md](ideas.md) #2). Promotes the evaluator's secrets check from glob-shape + LLM judgment to a real pattern scanner (gitleaks / trufflehog) run on the generated worktree through R7, emitting structured findings the evaluator includes verbatim. Pairs with A4's regex catalog; a direct hardening of the E8 gate.
- **Q2** — failure-mode taxonomy (structured error codes replacing free-form prose; shared vocabulary with E5's clarifier-gap codes).
  - *Evaluator-bundle follow-up — out-of-contract findings.* T1 pinned the evaluator's output to a per-criterion evidence bundle (`schemas/evaluator-evidence-bundle-v1.json`) and retired the legacy free-form `blockingConcerns[]` channel. Because every `criteria[].name` must satisfy the join-key invariant (it must match a criterion in the sprint contract), a genuinely *out-of-contract* finding — one that maps to no contract criterion — has no representation in the bundle. E8 (v1.0) makes this acute: the independent review pass produces exactly such findings. Q2 defines how orphan findings are surfaced — a structured out-of-contract record carried alongside the per-criterion verdicts, keyed by a Q2 error code (sharing the E5 clarifier-gap vocabulary) — plus the renegotiation-trigger semantics. Per T1's "additive stays on v1" rule this lands as a NEW OPTIONAL top-level bundle field (a field rename or a change to existing per-criterion semantics would instead force `evaluator-evidence-bundle-v2`). Surfaced by the post-merge review of T1; not a defect in T1 — a deferred design decision Q2 owns, now load-bearing for E8.
- **[T4](T4-run-configuration-record.md)** — run-configuration trace record. A per-run `runConfiguration` event (framework version, config digest, active stacks, agent roster + per-role model, trust posture, resolved harness knobs) for run-level debugging and V1's cross-run comparison. Additive new event class on `run-trace-v1`. Now also records E8's reviewer model, distinct from the generator's.
- **A4** — PII / secret regex catalog (per-stack regex bank layered on `secretsGlob`; the data behind the deterministic secret scan above).
- **E5 round 2** — confidence-scored adaptive clarification depth; optional persistence of resolved clarifications to `additionalContext`.
- **Per-stack overlay command override — real support (supersedes W1's cut warning).** v1.0 has no per-stack command override: the `auditCmd` / `buildCmd` / `testCmd` / `lintCmd` fields exist only in the **stack** schema, and the overlay schema (`overlay-v1.json`, `additionalProperties: false`) has no per-stack block, so such an overlay declaration is a `SchemaMismatch` error — not an accepted-then-ignored value. W1 originally planned a `PerStackOverrideUnsupported` warning here; it was **cut before shipping** because the premise was false — the warning could never fire without a contradicting schema error, and on a real `/gan` run the aborting `validateAll()` halts before any warning surfaces (the `reads.ts` trust-summary `perStackOverridesCount` is likewise a hardcoded `0`, "not yet implemented"). The v1.1 spec must therefore deliver the *implementation*, not a warning: (1) extend the overlay schema to v2 (per F3, a real schema change is a version bump and its own decision) with a schema-valid per-stack command-override block; (2) wire the overrides through the cascade and the resolved-config snapshot so they actually replace the stack-file defaults during sprints; (3) update the trust summary to count them. Once overrides are accepted and applied there is no "recorded but ignored" state left to warn about — the honest surface is the working override itself.
- **Schema-runtime alignment via generation or contract tests** — closes F5's surgical fix with the structural one.
- **F6 → trust-prompt enforcement (new spec).** Builds on F6's documentation baseline with server-side enforcement options: rate-limiting, content-hash echo, structured audit log, scoped capability tokens (per F4's `[deferred-to-v1.1]` markers). The R7 bridge widens the command-execution surface, so this enforcement work is more load-bearing post-R7.
- **`getMergedSplicePoints` inclusion-rule documentation (new spec).** Defines which fields participate; reserved fields like `stack.override` surface elsewhere.
- **Stack-file naming convention (new spec).** Publishes one rule for stack-file names; matters once `gan stacks list` has 5+ entries.

## v1.2 — enforce & reproduce

Requires production usage data the v1.0 → v1.1 cycle produces. The theme is **enforce and reproduce**: budget ceilings, destructive-action guards, and reproducible verdicts that harden the E8 gate against drift.

- **Q1** — diff acceptance feedback loop (`.gan-state/feedback/`; per-stack acceptance/churn/revert rates).
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

## Out of scope for this roadmap

- **Cross-run learning / auto-curated project memory.** `/gan` stays a reader of documented overlay files; it never writes durable project knowledge *unless* the user explicitly confirms promotion (e.g. E5 v1.1's offer to save resolved clarifications as project-tier `additionalContext`). The framework never auto-curates; the user always confirms.
- **Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery.** Users opt in explicitly via `additionalContext` (U3).
- **Real-ecosystem stacks beyond `web-node` pre-v2.0.** The deferred S-series specs (Android, KMP, iOS Swift) capture a starting point; reactivation is gated by the criteria in [`specifications/deferred/README.md`](deferred/README.md). Desktop and embedded stacks follow the same template if and when the pattern is proven on a second real ecosystem.
- **Cross-language benchmarking pre-v2.0.** B3 (TerminalBench / Aider polyglot) waits for real cross-language stacks to exist.

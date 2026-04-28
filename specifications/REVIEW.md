# Specification review — introduction for the reviewer

> **Status: third pass (or later).** Two prior review passes closed; responses in [REVIEW_RESPONSE.md](REVIEW_RESPONSE.md) and [REVIEW_RESPONSE_2.md](REVIEW_RESPONSE_2.md). The spec set has been revised in ~25 commits across both passes. The second pass surfaced concrete architectural concerns (hash blast radius, evaluator deterministic-core honesty, projectRoot canonicalisation, snapshot freshness "may"); each is addressed. Open the response files if you want a full audit trail; the "What's been addressed" section below summarises closures since first authoring.

## What you're looking at

`specifications/` contains **27 specs plus this letter, REVIEW.md, and the prior review's response**. They describe a redesign of ClaudeAgents — a framework for AI-driven software development workflows — into a tech-stack-agnostic system organised around a **Configuration API** that hides storage, validation, and merging behind a small set of named functions.

The redesign's end state, in one paragraph: a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, …) installs ClaudeAgents once (Node required at install time only), restarts Claude Code once, and `/gan` operates on their project. Adding a new ecosystem is a file drop, not a code change. Per-ecosystem behaviour lives in declarative stack files; per-project customisation in overlays with a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config / durable state / cache zones with non-overlapping lifecycles. The **Configuration API** is the architectural backbone — agents call its functions and never parse files directly. A trust-cache mechanism (F4 + R5) gates project-defined commands so a maintainer reviewing someone's PR doesn't accidentally execute their committed shell commands.

[`roadmap.md`](roadmap.md) is the entry point and contains the full vision and phase ordering. Read it first.

## How the spec set is organised

Files are named by **phase code**:

- **F** — Foundations (filesystem layout, API contract, schema authority, threat model)
- **C** — Configuration domains (data models the API exposes)
- **R** — Reference implementation (MCP server, installer, CLI, maintainer tooling, trust cache)
- **E** — Agent integration (orchestrator, agent rewrites, evaluator pipeline harness, stack extraction)
- **M** — Modules (runtime utility libraries)
- **S** — New stacks (Android, KMP, iOS Swift)
- **U** — User-facing extensibility (overlay UX, additionalContext)
- **O** — Observability and operations

The phase code in each filename is also the implementation order. A spec at position N never declares a dependency on a spec at position ≥ N — verified by an audit. **Three explicit revision breaks** sit between phases (post-R contracts, post-E1 + O2 first authoring, post-M module surface) where the spec set is re-checked against the actual implementation before further phases begin. The earlier post-S schema check is no longer in the active plan; the S-series specs are deferred (see below).

## Suggested reading order

1. [`roadmap.md`](roadmap.md) — vision, phase structure, revision-break placement.
2. **Foundations:** [F1](F1-filesystem-layout.md), [F2](F2-config-api-contract.md), [F3](F3-schema-authority.md), [F4](F4-threat-model-and-trust.md). Challenge the foundations before anything else rests on them. F4 is new since the first review pass.
3. **Configuration domains:** [C1](C1-stack-plugin-schema.md) through [C5](C5-stack-file-resolution.md). Walk the cascade, the detection-dispatch examples, and the splice-point catalog (now authoritative in C3) critically.
4. **Reference impl + agent integration:** [R1](R1-config-mcp-server.md) through [R5](R5-trust-cache-impl.md), then [E1](E1-agent-integration.md), [E2](E2-builtin-stack-extraction.md), [E3](E3-evaluator-pipeline-harness.md). E3 is significantly reframed since the first review (deterministic-core, no LLM in CI). R5 is new.
5. **Modules:** [M1](M1-modules-architecture.md), [M2](M2-docker-module.md). Spot-check the module ↔ stack name pairing and the zone boundaries.
6. **User-facing surfaces:** [U1](U1-project-overlay-ux.md), [U2](U2-user-overlay-ux.md), [U3](U3-additional-context-splice.md), [O1](O1-resolution-observability.md). Read as a user, not a maintainer.
7. [O2](O2-recovery.md) — read as background only; the post-E1 revision break is where O2 gets first prescriptively written.
8. [`deferred/`](deferred/README.md) — optional. Three real-ecosystem stack files (Android, KMP, iOS Swift) authored, reviewed, and intentionally postponed. Read the README for the deferral rationale and reactivation criteria; the spec bodies are background only since no Phase 5+ work depends on them in the active plan.

## What I'd most like you to challenge

Two prior review passes have closed the architectural questions I most worried about (Configuration API as black-box, F4 trust-cache shape, snapshot-freshness model, E3's deterministic-core honesty, projectRoot canonicalisation, splice-point catalog drift). Open targets for a third-pass reviewer, in declining importance:

1. **Implementation-imposed corner cases.** The spec set is now reasonably complete on paper, but the post-R, post-E1, and post-M revision breaks expect that real implementation surfaces gaps. A reviewer reading the spec set as "what would I build to fulfill this?" may catch gaps that paper-review missed. Push hardest where you would actually start writing code.

2. **F5 (transitive trust) — is the deferral honest?** F4 explicitly accepts that the trust hash covers config files but not the scripts they invoke (e.g. `lintCmd: ./scripts/my-lint.sh`). The deferred user workflow is "review every PR's script changes manually." Push back if you think this gap leaves a hole users will not realistically notice in practice.

3. **The new resolution rules from second-pass.** Cross-stack securitySurfaces id namespacing (`<stack>.<id>`), discardInherited+scalar-default fall-back, cacheEnv conflict resolution requiring all-conflicting-stacks-overridden, snapshot freshness as always-after-agent-writes / never-on-user-edits, and project-tier-shadow pairsWith error guidance — these all landed since the second-pass review. Walk a fresh fixture through them; flag any rule that doesn't compose cleanly with another.

4. **Phase ordering, fourth-pass version.** Three revision breaks plus one "operational readiness" check inside post-R. O1 part-A carved out into R1's Phase 2 work for early observability. Is the staging right, or is something still mis-phased?

5. **F4 + F5 trust model in detail.** The trust-cache UX has now been specified concretely (`getTrustDiff` semantics, lock file, mode 600, export/import for CI, error-text discipline). Is any of it still wishful?

6. **Cascade scenarios beyond the eight documented ones.** First pass walked five; second pass walked five more. All addressed. A fresh reviewer may find a tenth.

## What's been addressed across both review passes

(Skim or skip; pasted here so a third-pass reviewer doesn't re-flag closed items.)

**Architecture (first pass + second pass):**
- F4 (Threat model + trust boundaries) added as a Phase 0 spec. R5 (trust-cache reference impl) added as a Phase 2 spec. Second pass tightened: hash blast radius explicitly named as accepted limitation; recommended workflow + future F5; per-file hash storage for `getTrustDiff`; flock-based concurrency; trust manifest export/import for CI.
- F2 every function takes explicit `projectRoot` with mandatory canonicalisation at the API boundary; capability-binding flagged for post-R audit.
- List-shaped writes have dedicated atomic operations (`appendToStackField`, `removeFromStackField`).
- Snapshot freshness pinned: frozen-on-user-edits, always-re-snapshot-after-agent-writes (no "may"). Two-tier deterministic contract.
- E3 reframed around the evaluator's deterministic core; pre-diff scope explicitly disclosed; `picomatch` pinned for glob determinism; future trigger-types must be pure functions.
- C3's splice-point catalog is the authoritative single source of truth with merge-rule column; C4 references it; the design assumption "splice points resolve independently" is documented.
- `stack.cacheEnvOverride` splice point added; conflict resolution requires all conflicting stacks to resolve to the same final value.
- `stack.override` forbidden in user tier.
- Cross-stack `securitySurfaces` id collisions resolved via `<stack>.<id>` namespacing.
- `discardInherited` + scalar-no-replacement falls back to bare default per C3.
- `pairsWith.consistency` error message names the fix when project-tier shadowing is the cause.
- F2 makes explicit that modules do not register their own MCP tools.

**UX, errors, observability:**
- Structured error enum extended: `UntrustedOverlay`, `TrustCacheCorrupt`, `PathEscape`.
- O1's `discarded` array now includes `replacedWith` so debuggers see what was discarded *and* what filled the gap.
- O1's `--print-config` pinned fail-open (prints partial resolved view + structured errors).
- `--no-project-commands` runtime flag specified for review-other-people's-branches use.
- R2's installer gains `--no-claude-code` for headless / CI installs.

**Process:**
- Post-M revision break added (M1+M2 first exercise F2's module surface).
- Post-R audit explicitly includes F4/R5 operational readiness check.
- Post-E1 break renamed to acknowledge O2 gets *first prescriptively authored* there, not merely audited.
- E1 → E3 → E2 implementation order documented (numbering reflects authoring order, not impl order).
- E2 gains a five-slice bite-size sprint plan; rating bumped from medium to medium-large.
- Roadmap headline corrected: "Node is required once at install time" (not "never need Node").
- O1 part A (startup log line) carved out into R1's Phase 2 work so early users have minimum-viable observability before the full O1 lands in Phase 5.
- Phase 5 (real-ecosystem stack files: Android, KMP, iOS Swift) deferred and the corresponding S-series specs moved to [`specifications/deferred/`](deferred/README.md). Phases 5 / 6 / 7 of the active roadmap are now Resolution observability / User-facing extensibility / Recovery (renumbered down by one). The risk that motivated Phase 5 (framework calcifies around web-node) is now addressed by the **multi-stack guard rail** principle: a fixture-only synthetic stack, an R4 `lint-no-stack-leak` script, and an E3 cross-stack capability assertion. See the roadmap's Cross-cutting principles for the full mechanism.

**Spec hygiene:**
- Stack name case-sensitivity rule (`^[a-z][a-z0-9-]*$`) in C1.
- Path-escape rule (`PathEscape`) in F4 covers `additionalContext` and any future path-bearing splice point.
- pairsWith on project-tier replacement explicitly documented in C5 with remediation hint in the error message.
- `additionalChecks` execution order = merge order, documented in C4 with worked example showing in-place override positioning.
- `gan migrate-overlays` CLI subcommand defined in R3; rationale documented in F3.

## Known gaps still open

Down to a small set since most prior-pass gaps are closed:

1. **Telemetry / privacy spec.** Still deferred. Will be authored alongside O2's first prescriptive revision in the post-E1 break.
2. **JSON Schema documents at `schemas/<type>-vN.json` are described in prose but not yet committed.** They land alongside R1 implementation.
3. **Worked end-to-end fixture.** Suggested by both prior reviewers. Not yet done; a polyglot web-node + synthetic-second walk-through (the bootstrap multi-stack fixture from E3) would catch cross-spec inconsistency. Worth doing before any new reviewer reads.
4. **F4's prompt UX is described in prose.** No mockup, no transcript, no per-platform validation (terminal width, colour, accessibility).
5. **F5 (transitive trust hashing) is named but not specified.** Accepted v1 limitation; future work.

## Things you don't need to read carefully

- **[O2](O2-recovery.md) — Recovery.** Header note says "descriptive of intent, not prescriptive of mechanism." First prescriptive authoring happens in the post-E1 revision break. Reading the body for *intent* is fair; reading for *implementability* is premature.
- **JSON Schema documents at `schemas/<type>-vN.json`.** Authored alongside R1 implementation; not yet committed.
- **Per-stack security surface catalogues** in [deferred/S1](deferred/S1-android-stack.md), [deferred/S3](deferred/S3-ios-swift-stack.md). Read for *coverage and shape*, not for "did the author pick the right list of surfaces" — and remember these specs are deferred, so any criticism of their content is informational, not gating.
- **[REVIEW_RESPONSE.md](REVIEW_RESPONSE.md)** and **[REVIEW_RESPONSE_2.md](REVIEW_RESPONSE_2.md)** — prior reviewers' responses, retained as records. Read for context if you want to know what was challenged before; don't re-litigate the closed items.

## What I'm asking for (unchanged from first pass)

Adversarial review. Tell me where the architecture is wrong, where a spec is under- or over-specified, where the cascade or detection or trust model breaks down on a scenario I didn't anticipate. The seven "challenge" questions above are the highest-value targets; the four "known gaps" are honest pre-emptive disclosures.

Specific things I do **not** need:

- Style or wording polish.
- Proofreading.
- Implementation-level critique of code that doesn't exist yet (no schemas, no MCP server, no agent rewrites are committed).
- Re-litigation of items already closed in the first review pass (see "What's been addressed" above).

Specific things I **do** need:

- Architecture-level pushback on F4, R5, the evaluator-core boundary in E3, projectRoot in F2, the splice-point catalog stability.
- Cascade-and-merge scenarios that the rules don't cover cleanly.
- Phase-ordering arguments. If a fifth revision break is needed, or one of the existing four should move, say so.
- Holes in the dependency graph or the runtime boundary.
- Any place where an agent prompt or user-facing message would need to mention something a non-Node user shouldn't have to know about.
- Any place where F4's trust-cache could be bypassed or where the threat model has been mis-scoped.

Thank you.

## Format conventions

- Each spec has the same skeleton: **Problem** → **Proposed change** → **Acceptance criteria** → **Dependencies** → **Bite-size note**. Some have additional sections (parse contract, error model, conventions, runtime boundary) where the topic warrants.
- Markdown body is prose for humans. Where YAML appears, it is illustrative unless explicitly marked as the parse contract.
- Cross-references use phase codes (F1, C3, R2, …) and link to the file with the matching prefix.
- "User-facing" means runs on a developer's machine via `/gan`; "maintainer" means runs in the framework's own CI.
- Pre-1.0 WIP framing throughout: no backward-compat hedging, no transitional dual-paths, schema bumps are unconditional.

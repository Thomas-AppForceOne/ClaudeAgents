# Specification review — introduction for the reviewer

> **Update.** The first review pass landed (response in [REVIEW_RESPONSE.md](REVIEW_RESPONSE.md)) and produced a substantial spec revision before this letter goes to a second reviewer. The revision is captured across 11 commits between `c8cfea8` and `44ea967`. Highlights: F4 (threat model + trust boundaries) added to Phase 0; R5 (trust-cache reference impl) added to Phase 2; E3 reframed around an evaluator deterministic core (no LLM in CI); F2 gains explicit `projectRoot` on every call and atomic `appendToStackField`/`removeFromStackField`; C3's splice-point table is now the canonical catalog with merge rules; `stack.cacheEnvOverride` splice point closes the cacheEnv conflict path; `stack.override` forbidden in user tier; snapshot freshness pinned (frozen for whole run); post-M revision break added; E3 → E2 implementation order documented; `--no-project-commands` flag specified; Node honestly described as one-time install dep; many smaller edits.

## What you're looking at

`specifications/` contains 25 specs plus this letter. They describe a redesign of ClaudeAgents — a framework for AI-driven software development workflows — into a tech-stack-agnostic system organised around a **Configuration API** that hides storage, validation, and merging behind a small set of named functions.

The redesign's end state, in one paragraph: a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, …) installs ClaudeAgents once, restarts Claude Code once, and `/gan` operates on their project. Adding a new ecosystem is a file drop, not a code change. Developers on non-Node ecosystems never need to install Node. Per-ecosystem behaviour lives in declarative stack files; per-project customisation in overlays with a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config / durable state / cache zones with non-overlapping lifecycles. The **Configuration API** is the architectural backbone — agents call its functions and never parse files directly.

[`roadmap.md`](roadmap.md) is the entry point and contains the full vision. Read it first.

## How the spec set is organised

Files are named by **phase code**:

- **F** — Foundations (filesystem layout, API contract, schema authority)
- **C** — Configuration domains (data models the API exposes)
- **R** — Reference implementation (MCP server, installer, CLI, maintainer tooling)
- **E** — Agent integration (orchestrator and per-agent rewrites)
- **M** — Modules (runtime utility libraries)
- **S** — New stacks (Android, KMP, iOS Swift)
- **U** — User-facing extensibility (overlay UX, additionalContext)
- **O** — Observability and operations

The phase code in each filename is also the implementation order. A spec at position N never declares a dependency on a spec at position ≥ N — verified by an audit. Three explicit **revision breaks** sit between phases (post-R, post-E1, post-S) where the spec set is re-checked against the actual implementation before further phases begin.

## Suggested reading order

1. [`roadmap.md`](roadmap.md) — vision and phase structure.
2. [F1](F1-filesystem-layout.md), [F2](F2-config-api-contract.md), [F3](F3-schema-authority.md) — challenge the foundations before the rest of the structure rests on them.
3. [C1](C1-stack-plugin-schema.md) through [C5](C5-stack-file-resolution.md) — data models. Walk through the cascade and detection-dispatch examples critically.
4. [R1](R1-config-mcp-server.md) through [R4](R4-maintainer-tooling.md), and [E1](E1-agent-integration.md), [E2](E2-builtin-stack-extraction.md), [E3](E3-capability-test-harness.md) — implementation contracts. Check for over-specification or scope creep.
5. [M1](M1-modules-architecture.md), [M2](M2-docker-module.md) and [S1](S1-android-stack.md), [S2](S2-kmp-stack.md), [S3](S3-ios-swift-stack.md) — application layers. Spot-check that the schema actually supports what the stacks declare.
6. [U1](U1-project-overlay-ux.md), [U2](U2-user-overlay-ux.md), [U3](U3-additional-context-splice.md) and [O1](O1-resolution-observability.md) — user-facing surfaces. Read as a user, not a maintainer.
7. [O2](O2-recovery.md) — read as background only, with the "needs revision" header in mind.

## What I'd most like you to challenge

- **Is the Configuration API the right abstraction?** Agents are reframed as API clients; storage is a black box behind named functions. The whole rest of the design assumes this is correct.
- **Is the cascade model honest?** Three tiers (default → user → project), per-splice-point merge rules, `discardInherited` as the escape hatch. Walk a few scenarios end-to-end and see if the rules feel right.
- **Does the runtime boundary hold?** Maintainer tooling assumes Node 18+; user-facing behaviour is owned by the agent at runtime. iOS / embedded / Swift-only developers should never need Node. Look for places where this leaks.
- **Are the three revision breaks the right checkpoints?** Or should there be more / fewer / different?
- **Bite-size sizing.** Each spec is supposed to be sprintable. Several have explicit slice plans in their "Bite-size note." Is any spec actually too large or too narrow?
- **Phase ordering.** Foundations land before consumers, reference impls before refactors, observability before user-facing surfaces, recovery last. Is this the right sequence?

## Known gaps I'd like your judgement on

I am aware of these and chose not to fix them in this round. Push back if you disagree:

1. **No framework-level threat model.** Specs describe per-stack security surfaces, not the framework's own security posture. Open questions: can a hostile project overlay execute arbitrary commands via `evaluator.additionalChecks`? What permissions does the MCP server have? What stops a stack file in `.claude/gan/stacks/` from leaking secrets via a crafted `auditCmd`? My current position is "trust boundaries are at the OS level," but a real spec ("F4 — Threat model and trust boundaries") may belong eventually.
2. **No telemetry or privacy spec.** [O2](O2-recovery.md) mentions a telemetry directory; nothing specifies what's collected, where it goes, or opt-in/out. Pre-1.0 deferral, but worth your read.
3. **F2's function signatures are not formally pinned.** Names and bulk-shape semantics are documented; precise parameter and return JSON Schemas are not. The intent is to pin them in R1's MCP tool registration and validate during the post-R revision break. Push back if you think they should be pinned at F2 directly.
4. **R1's resolver is described in prose, not pseudocode.** Implementation detail, but a strict reviewer may want more rigor in the contract.
5. **No worked examples of complete configuration files.** Specs have fragmentary YAML throughout; no end-to-end "here's an Android+Node polyglot project's full config tree." That's tutorial material; tell me if you'd want one for review purposes.

## Things you don't need to read carefully

- **[O2](O2-recovery.md) — Recovery.** Its header note explicitly marks the body as "descriptive of intent, not prescriptive of mechanism." The recovery flow needs reconception under [F1](F1-filesystem-layout.md) (zones) and [E1](E1-agent-integration.md) (agent integration); that work is gated by the post-E1 revision break. Reading the body for *intent* is fair; reading it for *implementability* is premature.
- **JSON Schema documents at `schemas/<type>-vN.json`.** Authored alongside [R1](R1-config-mcp-server.md) implementation; not yet committed. The prose descriptions in the domain specs are the current source of truth.
- **Per-stack security surface catalogues** in [S1](S1-android-stack.md), [S3](S3-ios-swift-stack.md). They are deliberately exhaustive — Android has seven, iOS has eight — to validate that [C1](C1-stack-plugin-schema.md)'s schema is expressive enough. Read them for *coverage and shape*, not for "did the author pick the right list of surfaces."

## What's been preserved

- Every spec carries a **bite-size note** describing how to slice the work into single-sprint commits.
- Every spec lists its dependencies; the dependency graph is verifiably acyclic against the roadmap order.
- Every spec has concrete acceptance criteria — not "should work" prose, but testable assertions.
- Cross-references are uniform (phase codes everywhere; no stale numeric references).
- Pre-1.0 WIP framing is honest throughout: no backward-compat hedging, no transitional dual-paths, schema bumps are unconditional.

## Format conventions

- Each spec has the same skeleton: **Problem** → **Proposed change** → **Acceptance criteria** → **Dependencies** → **Bite-size note**. Some have additional sections (parse contract, error model, conventions, runtime boundary) where the topic warrants.
- Markdown body is prose for humans. Where YAML appears, it is illustrative unless explicitly marked as the parse contract.
- Cross-references use phase codes (F1, C3, R2, …) and link to the file with the matching prefix.
- "User-facing" means runs on a developer's machine via `/gan`; "maintainer" means runs in the framework's own CI.

## What I'm asking for

Adversarial review. Tell me where the architecture is wrong, where a spec is under- or over-specified, where the cascade or detection or pairing model breaks down on a scenario I didn't anticipate. The five "challenge" questions above are the highest-value targets; the five "known gaps" are honest pre-emptive disclosures, not invitations to skip them.

Specific things I do **not** need:

- Style or wording polish — those round-trip cheaply later.
- Proofreading — fine; flag if you spot something, but don't optimise the prose.
- Implementation-level critique of code that doesn't exist yet (no schemas, no MCP server, no agent rewrites are committed; this is a pre-implementation review).

Specific things I **do** need:

- Architecture-level pushback. If the Configuration API is the wrong abstraction, now is the time.
- Cascade-and-merge scenarios that the rules don't cover cleanly.
- Phase-ordering arguments. If post-S should come before post-E1, or if a fourth revision break is needed, say so.
- Holes in the dependency graph or the runtime boundary.
- Any place where an agent prompt or user-facing message would need to mention something a non-Node user shouldn't have to know about.

Thank you.

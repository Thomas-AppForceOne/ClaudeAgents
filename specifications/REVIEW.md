# Specification review — introduction for the reviewer

> **Status: second pass.** The spec set went through a first review pass (response captured in [REVIEW_RESPONSE.md](REVIEW_RESPONSE.md)) and has been substantially revised in 19 commits since. The "What's been addressed" section below summarises what changed; "What I'd most like you to challenge" lists the questions still worth pushing on. If you want to read the original first-pass letter, it's in this file's git history.

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

The phase code in each filename is also the implementation order. A spec at position N never declares a dependency on a spec at position ≥ N — verified by an audit. **Three explicit revision breaks** sit between phases (post-R contracts, post-E1 + O2 first authoring, post-M module surface, plus a post-S schema check) where the spec set is re-checked against the actual implementation before further phases begin.

## Suggested reading order

1. [`roadmap.md`](roadmap.md) — vision, phase structure, revision-break placement.
2. **Foundations:** [F1](F1-filesystem-layout.md), [F2](F2-config-api-contract.md), [F3](F3-schema-authority.md), [F4](F4-threat-model-and-trust.md). Challenge the foundations before anything else rests on them. F4 is new since the first review pass.
3. **Configuration domains:** [C1](C1-stack-plugin-schema.md) through [C5](C5-stack-file-resolution.md). Walk the cascade, the detection-dispatch examples, and the splice-point catalog (now authoritative in C3) critically.
4. **Reference impl + agent integration:** [R1](R1-config-mcp-server.md) through [R5](R5-trust-cache-impl.md), then [E1](E1-agent-integration.md), [E2](E2-builtin-stack-extraction.md), [E3](E3-evaluator-pipeline-harness.md). E3 is significantly reframed since the first review (deterministic-core, no LLM in CI). R5 is new.
5. **Modules + stacks:** [M1](M1-modules-architecture.md), [M2](M2-docker-module.md), [S1](S1-android-stack.md), [S2](S2-kmp-stack.md), [S3](S3-ios-swift-stack.md). Spot-check that the schema actually supports what the stacks declare.
6. **User-facing surfaces:** [U1](U1-project-overlay-ux.md), [U2](U2-user-overlay-ux.md), [U3](U3-additional-context-splice.md), [O1](O1-resolution-observability.md). Read as a user, not a maintainer.
7. [O2](O2-recovery.md) — read as background only; the post-E1 revision break is where O2 gets first prescriptively written.

## What I'd most like you to challenge

Highest-value targets for second-pass review, ordered by load-bearing-ness:

1. **Is F4's trust-cache mechanism the right shape?** The threat model is committed-overlay-as-RCE-surface. The fix is a content-hash trust cache plus a `--no-project-commands` flag. Specific things to push on:
   - Hash covers `.claude/gan/project.md` + `.claude/gan/stacks/*.md` + `.claude/gan/modules/*.yaml`. Should it also cover scripts that those files reference (e.g. a `lintCmd: ./scripts/my-lint.sh`)? Currently no — the script's contents can change without invalidating the trust hash.
   - Hash is SHA-256 over raw bytes in lex-sorted order, no Unicode normalisation. Reasonable, but a contributor with a different editor encoding could re-hash innocently.
   - The four-option prompt ([v]/[a]/[r]/[c]) is described in prose; no UX mockup. Ask if the flow makes sense to someone reviewing a PR locally.
   - `GAN_TRUST` env var has three modes. Is the default-strict the right default for CI? Are the modes named clearly?

2. **Is the E3 deterministic-core carve-out architecturally honest?** The new framing assumes the evaluator agent has a separable deterministic pipeline (snapshot → active stacks → security surfaces → commands → keywords) that produces a structured "evaluator plan" before any LLM analysis runs. The harness exercises only that core. Question: is the evaluator's *actual* logic separable that cleanly? E1's per-agent rewrite checklist promises the carve-out lives at `src/agents/evaluator-core/` after E1. If a chunk of "deterministic" decision-making turns out to need LLM analysis, the harness gates a smaller surface than it claims.

3. **Is F2's `projectRoot` parameter the right design choice?** Per-call explicit `projectRoot` works but is verbose for the orchestrator (every API call carries it). The reviewer first-pass identified three options (per-call parameter, per-project server, session handshake); we picked per-call. Is that the right call given MCP's actual semantics? If MCP gains session-state primitives later, would we regret the per-call choice?

4. **Is C3's authoritative splice-point catalog stable enough?** All splice-point definitions, defaults, tier-allowances, and merge rules now live in one C3 table. C4 references it; UX specs cite it abstractly. The reviewer first-pass flagged catalog drift across multiple specs; consolidation closes that. But: does this design hold when adding a splice point with an exotic merge rule (e.g. weighted average, set intersection)? The "common patterns" section in C4 lists the patterns covered today; an unforeseen pattern would need both C3 (table addition) and C4 (narrative addition).

5. **Is the phase ordering with three revision breaks right?** Post-R, post-E1 (where O2 gets first authored), post-M, post-S. Each break gates the next phase. Is anything missing? Is anything excessive? The roadmap claims this is "more discipline than most pre-1.0 redesigns ship with"; second-pass reviewer should push back if the discipline is theatre.

6. **Does the runtime boundary still hold under F4?** Maintainer tooling assumes Node 18+; user-facing behaviour is owned by the agent at runtime. F4 introduces `~/.claude/gan/trust-cache.json` and the `gan trust approve` CLI. Is any part of F4's UX accidentally Node-leaking — i.e., does an iOS developer running `/gan` ever see a Node-shaped error?

7. **Cascade-and-merge scenarios beyond the documented ones.** First-pass review walked five scenarios (§9 in REVIEW_RESPONSE.md) and found four that needed clarifications; all are now addressed. A fresh second-pass reviewer may find scenarios I and the first reviewer both missed.

## What's been addressed since the first review

(Skim or skip; pasted here so the second-pass reviewer doesn't re-flag closed items.)

**Architecture:**
- F4 (Threat model + trust boundaries) added as a new Phase 0 spec. R5 (trust-cache reference impl) added as a new Phase 2 spec.
- F2 every function takes explicit `projectRoot`. List-shaped writes have dedicated atomic operations (`appendToStackField`, `removeFromStackField`).
- E3 reframed around the evaluator's deterministic core. Renamed to "evaluator pipeline harness." No LLM in CI. Optional E4 (LLM eval suite) flagged as future, non-gating.
- Snapshot freshness pinned: frozen for the whole run including across multiple sprints.
- C3's splice-point catalog made authoritative with merge-rule column. C4 references C3 instead of duplicating.
- `stack.cacheEnvOverride` splice point added to resolve C1's cacheEnv conflict scenario without C5's wholesale-replacement path.
- `stack.override` forbidden in user tier (was a footgun: silently disabled auto-detection in every project).

**UX, errors, observability:**
- Structured error enum extended: `UntrustedOverlay`, `TrustCacheCorrupt`, `PathEscape`.
- O1's `discarded` array now includes `replacedWith` so debuggers see what was discarded *and* what filled the gap.
- O1's `--print-config` pinned fail-open (prints partial resolved view + structured errors).
- `--no-project-commands` runtime flag specified for review-other-people's-branches use.
- R2's installer gains `--no-claude-code` for headless / CI installs.

**Process:**
- Post-M revision break added (M1+M2 first exercise F2's module surface).
- Post-E1 break renamed to acknowledge O2 gets *first prescriptively authored* there, not merely audited.
- E1 → E3 → E2 implementation order documented (numbering reflects authoring order, not impl order).
- E2 gains a five-slice bite-size sprint plan; rating bumped from medium to medium-large.
- Roadmap headline corrected: "Node is required once at install time" (not "never need Node").

**Spec hygiene:**
- Stack name case-sensitivity rule (`^[a-z][a-z0-9-]*$`) in C1.
- Path-escape rule (`PathEscape`) in F4 covers `additionalContext` and any future path-bearing splice point.
- pairsWith on project-tier replacement explicitly documented in C5.
- `additionalChecks` execution order = merge order, documented in C4.
- Duplicate-key positioning (lower-tier slot wins) documented in C4.

## Known gaps still open

Down to a small set since most first-pass gaps are closed:

1. **Telemetry / privacy spec.** Still deferred. Will be authored alongside O2's first prescriptive revision in the post-E1 break, since O2 references a telemetry directory and recovery-archive contents are exactly the artifact a user might not want sent anywhere.
2. **JSON Schema documents at `schemas/<type>-vN.json` are described in prose but not yet committed.** They land alongside R1 implementation; reviewers checking schema correctness can only verify the prose description.
3. **Worked end-to-end fixture.** The first reviewer suggested one (e.g. polyglot-android-node walked through validateAll → getResolvedConfig → orchestrator startup → first sprint) and noted it would catch cross-spec inconsistency. Not done. A second-pass reviewer may want it.
4. **F4's prompt UX is described in prose.** No mockup, no transcript, no per-platform validation (terminal width, colour, accessibility).

## Things you don't need to read carefully

- **[O2](O2-recovery.md) — Recovery.** Header note says "descriptive of intent, not prescriptive of mechanism." First prescriptive authoring happens in the post-E1 revision break. Reading the body for *intent* is fair; reading for *implementability* is premature.
- **JSON Schema documents at `schemas/<type>-vN.json`.** Authored alongside R1 implementation; not yet committed.
- **Per-stack security surface catalogues** in [S1](S1-android-stack.md), [S3](S3-ios-swift-stack.md). Read for *coverage and shape*, not for "did the author pick the right list of surfaces."
- **[REVIEW_RESPONSE.md](REVIEW_RESPONSE.md)** — the first-pass reviewer's response, retained as a record. Read for context if you want to know what was challenged before; don't re-litigate the closed items.

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

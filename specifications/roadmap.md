# ClaudeAgents — Roadmap

## End state

ClaudeAgents is a framework for AI-driven software development workflows — sprint planning, code generation, review, verification — that works on any technology stack. When this redesign is fully shipped, a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, and more) installs ClaudeAgents once, restarts Claude Code once, and `/gan` operates on their project. Adding support for a new ecosystem is a file drop, not a code change. Node is required once at install time (the framework is distributed via npm); after install, daily workflow on a non-Node ecosystem never touches Node.

The architectural backbone is a **Configuration API** that hides storage, validation, and merging behind a small set of named functions. Agents call those functions; they do not parse files, do not know schemas, and do not enumerate tiers. Stack files declare per-ecosystem behavior; overlays apply per-user and per-project customization through a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config, durable state, and cache zones with non-overlapping lifecycles, so persistent module state cannot collide with per-run orchestration data. Configuration files are hand-editable; the API validates on read and surfaces structured errors when something is wrong.

The phases below trace the implementation path from foundations outward. Each spec is sized for a single sprint of focused work.

## How to read the spec set

Specs are organised by **phase code** (F = foundation, C = configuration domains, R = reference implementation, E = agent integration, M = modules, U = user-facing extensibility, O = observability and operations). Filenames carry the phase code so directory listings show the natural execution order. Foundations land before consumers; reference implementations land before refactors that use them; observability lands last.

The **S = stack-content** code is reserved for real-ecosystem stack files. The active plan ships exactly one real stack (`web-node`) plus a fixture-only synthetic stack used as a multi-stack guard rail (see "Cross-cutting principles" below). Authored-but-deferred S-series specs (Android, KMP, iOS Swift) live under [`specifications/deferred/`](deferred/README.md) until reactivation criteria are met; they are not part of the implementation order below.

## Phase 0 — Foundations

System contracts that every later spec depends on.

- [F1-filesystem-layout.md](F1-filesystem-layout.md) — Three project zones (`.claude/gan/`, `.gan-state/`, `.gan-cache/`) with single-owner lifecycles. Retires the old `.gan/` directory.
- [F2-config-api-contract.md](F2-config-api-contract.md) — Black-box function surface, MCP binding, validation timing, install/restart story, error model.
- [F3-schema-authority.md](F3-schema-authority.md) — JSON Schema location, `schemaVersion` semantics, lint integration.
- [F4-threat-model-and-trust.md](F4-threat-model-and-trust.md) — Threat model, trust-cache contract, `UntrustedOverlay` error, `GAN_TRUST` modes, `--no-project-commands` flag, path-escape rules. Lands in Phase 0 because committed overlays + arbitrary commands is a real attack surface that needs closing before user-facing extensibility (Phase 6) opens it up.

## Phase 1 — Configuration domains

Data models the API exposes.

- [C1-stack-plugin-schema.md](C1-stack-plugin-schema.md) — Stack file schema, detection composites, parse contract.
- [C2-stack-detection-and-dispatch.md](C2-stack-detection-and-dispatch.md) — Dispatch algorithm, scope filtering, generic fallback.
- [C3-overlay-schema.md](C3-overlay-schema.md) — Overlay splice points, defaults, `discardInherited`.
- [C4-three-tier-cascade.md](C4-three-tier-cascade.md) — default → user → project merge per splice point.
- [C5-stack-file-resolution.md](C5-stack-file-resolution.md) — project → user → repo lookup for stack files.

## Phase 2 — Reference implementation

The MCP server and tooling that fulfill Phases 0–1.

- [R1-config-mcp-server.md](R1-config-mcp-server.md) — Node 18+ MCP server implementing F2.
- [R2-installer.md](R2-installer.md) — `install.sh`, MCP registration, zone preparation.
- [R3-cli-wrapper.md](R3-cli-wrapper.md) — `gan validate`, `gan config`, `gan stacks`.
- [R4-maintainer-tooling.md](R4-maintainer-tooling.md) — Lint script, schema publisher, evaluator-pipeline-check runner, pair-names check, CI workflows.
- [R5-trust-cache-impl.md](R5-trust-cache-impl.md) — Reference implementation of F4: hash function, cache I/O, `validateAll()` integration, `getTrustState`/`trustApprove` MCP tools, `--no-project-commands` runtime flag routing, `PathEscape` invariant.

## Revision break — post-R contract audit (incl. F4/R5 operational readiness)

The R series is the first time the F-phase contracts and C-phase data models are exercised against real code (the MCP server, installer, CLI, lint, trust cache). Before Phase 3 begins, every contract spec is re-audited against its implementation to surface gaps the spec missed.

Specs to revisit, with what to verify:

- **F2** — confirm the function surface and structured-error model match what R1 actually exposes; refine signatures, error codes, and bulk-read shapes if implementation surfaced different patterns. Includes the F2 capability-binding flag (per F2's "Capability binding" subsection): is any caller surfacing user-influenced strings into `projectRoot`?
- **F3** — confirm the JSON Schema documents at `schemas/<type>-vN.json` cover everything R1 needs to validate; add fields or invariants the implementation found necessary.
- **F4 + R5 operational readiness** — exercise the trust prompt against at least three real PRs of varying shape (config-only change; config + script change; new project-tier stack file). Confirm: (a) the `[v]` view-the-diff branch produces output users can actually act on; (b) `getTrustDiff()`'s per-file-hash report is legible; (c) `--no-project-commands` log content names every suppressed surface including custom-stack drop-throughs; (d) `gan trust export`/`import` round-trips cleanly; (e) error texts pass the iOS-on-macOS readability check (no Node/npm leaks). This gate exists because U1 / U2 (Phase 7) are when committed overlays go mainstream — if R5's prompt UX has rough edges discovered late, the user-facing rollout in Phase 7 inherits them.
- **C1, C2, C3, C4, C5** — confirm the algorithms and merge rules described match what R1's resolver actually does; clarify ambiguities found during implementation.

Like the post-E1 break, this is a checkpoint: specs are revised in place; no new files. No Phase 3 work begins until the audit closes.

## Phase 3 — Agent integration

Existing agents start using the new system.

- [E1-agent-integration.md](E1-agent-integration.md) — Orchestrator and agent prompt rewrites. SKILL.md, gan-planner, gan-contract-proposer, gan-generator, gan-evaluator, gan-recover all consume the Configuration API instead of parsing files. Single coordinated PR with per-agent sprint slices.
- [E2-builtin-stack-extraction.md](E2-builtin-stack-extraction.md) — Extract `web-node` and `generic` into `stacks/<name>.md` files written via the API. Per the single-real-stack principle below, other ecosystem-specific tokens currently living in old prompts (Python, Rust, Go, Ruby, Kotlin, Gradle, etc.) are content-mining sources for the extraction audit — each must be lifted into web-node/generic, retained as synthetic-second fixture content, or explicitly retired.
- [E3-evaluator-pipeline-harness.md](E3-evaluator-pipeline-harness.md) — Tests the evaluator's *deterministic core* (snapshot → active stacks → security surfaces → commands → keywords). Fixtures + hand-authored evaluator-plan goldens. No LLM in CI. Optional E4 (LLM-eval suite, if ever needed) is a separate, future, non-gating spec.

**Implementation order within Phase 3 — spec-completion order, not commit order.** Phase 3 is a single coordinated PR (per E1's "Migration approach" subsection). Within that PR, the spec-completion order is **E1 → E3 → E2**: E1 specifies what the rewritten agents do, E3 specifies the harness that gates the rewrite, E2 specifies the stack content the rewritten agents will consume. E2 is gated by E3 in correctness-verification terms; E3 cannot run against the rewrites until E1 lands.

The **commit order inside the PR**, however, is the reverse for the prompt-content path: E2's stack-extraction commits land **before** E1's rewrite-in-place commits on `agents/*.md`, so the old prompts are still present as the content reference during extraction. Once E1's commits delete the old prompt content, anything not yet lifted is unrecoverable except from git history.

The two orderings are compatible because they describe different things — spec-completion order describes which spec is authoritatively complete first; commit order describes which lines change first inside the implementation PR. A reader who sees "E1 first" in the implementation order should understand it as "E1's contract is finalised first (it's what E2 and E3 consume)," not "the prompts are gone before E2 starts."

## Revision break — post-E1 audit + O2 first prescriptive revision

E1 is the largest behavioral change in the roadmap and several downstream specs reference its outcome without yet knowing the concrete details. Before continuing past Phase 3, every spec that carries an "E1 dependency" note is re-audited against E1's actual implementation. Most are revised in place. **O2 gets its first prescriptive authoring here — not just an audit.**

Specs to revisit, with what to verify:

- **O1** — confirm the orchestrator's startup-log shape matches what E1's coordinator actually emits; refine output format if needed.
- **O2** — full reconception of the recovery flow under F1's zone layout and E1's snapshot model. The current spec is explicitly marked "descriptive of intent, not prescriptive"; this is where it becomes prescriptive. Real authoring work, not editing.
- **U3** — validate that planner/proposer consumption of `additionalContext` works end-to-end via the snapshot; update the spec if the consumption pattern differs from what's currently described.

Plus a general re-audit of every post-E1 spec for ambiguities E1 implementation may have surfaced.

This break is a checkpoint with one substantive new authoring (O2). No Phase 4 work begins until both the audit and O2's revision close. Doing this now prevents Phases 4–8 from being built on assumptions that turn out to be wrong.

## Phase 4 — Modules

Runtime utility libraries; independent of Phases 0–3 conceptually.

- [M1-modules-architecture.md](M1-modules-architecture.md) — Module manifest, lifecycle, `pairsWith` enforcement via API, filesystem zone boundaries, distribution.
- [M2-docker-module.md](M2-docker-module.md) — PortRegistry, PortDiscovery, ContainerHealth, PortValidator, ContainerNaming. Persists state in `.gan-state/modules/docker/`.

## Revision break — post-M module surface audit

M1 + M2 are the first time F2's module surface (`registerModule`, `getModuleState`, `setModuleState`, the `pairsWith` invariant) is exercised against real modules. R1's implementation of these in Phase 2 had no concrete module to validate against. Before Phase 5, the module-related parts of F2, F3, R1, M1 are re-audited against M2's actual implementation.

Specs to revisit, with what to verify:

- **F2** — confirm the module-state functions handle the project-rooting story correctly (see post-R audit) and that registration timing is unambiguous.
- **F3** — confirm `module-manifest-v1.json` and any module-config schemas (e.g. `module-config-docker-v1.json`) cover what M2 actually needs.
- **R1** — confirm the `pairsWith` invariant catches the failure modes M2 surfaces; confirm `registerModule` lifecycle (when it runs, idempotency, error handling) matches what M1 needs.
- **M1** — refine the lifecycle prose if M2 implementation surfaced timing/sequencing details the architecture spec missed. Specifically address whether barrel-runs-prerequisites-at-import scales — at two shipped modules it is fine, but the cost grows linearly in shipped-module count and is paid even when the paired stack is inactive. Audit whether prerequisites should move to lazy / paired-stack-gated execution before more modules ship.
- **C4** — audit module-config cascade semantics: per-module config at `.claude/gan/modules/<name>.yaml` is declared in M1 and M2, but C4's splice-point catalog has no `modules.*` entries. Determine whether module configs participate in the three-tier cascade at all, and if so what merge rules apply (scalar: higher-tier wins; list: union-dedup; or fully self-defined by each module's schema with no cross-tier merging). Must be resolved before any module ships a multi-tier-aware config field.
- **M1/F2** — clarify `stateKeys` semantics: the manifest field `stateKeys` (e.g. `["port-registry"]` in the docker manifest) is currently decorative — neither M1 nor F2 defines what it enforces or what happens if a module writes a key not in the list. F2's `setModuleState(moduleName, key, value)` signature implies per-key blobs, but M1's implementation is whole-blob. Audit: does `stateKeys` become an allowlist, documentation only, or is it removed? Resolve before a second module ships its own state keys.
- **F2/M1** — reconcile `appendToModuleState` signature: F2 specifies `appendToModuleState(moduleName, key, entry, duplicatePolicy="error")` with explicit duplicate-handling semantics, but M1's implementation drops the `duplicatePolicy` parameter and unconditionally appends. Audit: should `duplicatePolicy` be added (and what are the valid values: `"error" | "skip" | "allow"`), or should F2 be revised to drop it? Same shape as the `stateKeys` divergence — either implement the spec or update the spec to match. Resolve before module callers come to depend on duplicate-detection behaviour.
- **F2/M1** — reconcile `removeFromModuleState` lookup semantics: F2 specifies `removeFromModuleState(moduleName, key, entryKey)` where the `entryKey` parameter name implies keyed lookup (find the entry whose key matches and remove it). M1's implementation takes a `value` parameter and performs deep-equal removal of any matching entry instead. Distinct from the `stateKeys` question (which asks whether per-key blobs exist at all) — this asks, given the chosen storage model, whether removal targets a key or a value. Audit: align on one semantic (keyed lookup vs deep-equal match) and update either the spec or the implementation. Resolve before any module relies on the current deep-equal behaviour.

### Resolutions (2026-05-07)

- **F2** — closed with a minor edit to the `registerModule` table row clarifying that the tool is a runtime probe (not a registration trigger) and that the `manifest` argument is currently advisory; the production registration cache is built lazily by `getRegisteredModules()`.
- **F3** — closed with no edit; both schemas already cover what M2 declares and uses.
- **R1** — closed with no edit; the misleading registration-timing prose lived in M1 (not R1) and was fixed there.
- **M1** — closed with edits to the registration-time bullet (clarifying lazy registration), the `stateKeys`/`configKey` paragraph (replacing the "decorative" note with the post-audit conclusion), and the persistence bullet (per-key state files). The prerequisite-scaling cost note is left in place for the next revision break — at two shipped modules the O(N) cost is still acceptable, but the question is genuinely open and the note should travel with M1 until it's answered.
- **C4** — module configs at `.claude/gan/modules/<name>.yaml` are **project-tier-only** and do not participate in the three-tier cascade. C4 gains a "Module configurations" section codifying this. C3's splice-point catalog stays free of `modules.*` entries by design.
- **M1/F2 (stateKeys)** — `stateKeys` is the **authoritative allowlist** of named state blobs the module owns. Each declared key persists to its own file at `.gan-state/modules/<name>/<key>.json`. The Configuration API rejects writes to undeclared keys with a structured error. The original F2 design (per-key blobs) is restored; M1's whole-blob implementation was a shortcut that silently dropped F2's `key` parameter.
- **F2/M1 (duplicatePolicy)** — the F2 spec wins: `appendToModuleState(moduleName, key, entry, duplicatePolicy="error")` is the correct signature. The M1 implementation must add the parameter to match the existing `appendToOverlayField` / `appendToStackField` convention.
- **F2/M1 (removeFromModuleState)** — the F2 spec wins: `removeFromModuleState(moduleName, key, entryKey)` is the correct signature. Removal is by entry key (keyed lookup), not by deep-equal value match.

### Implementation alignment

Three of the eight decisions (stateKeys allowlist, duplicatePolicy, removeFromModuleState lookup) require code changes that bring M1's module-state surface back in line with F2's per-key contract. The detailed implementation contract is authored separately as **M3** (see Phase 4 alignment below), following the precedent set by the post-E1 revision break which produced O2's first prescriptive spec inside that break.

Same checkpoint discipline as the other revision breaks: spec revisions and the M3 implementation ride together; no Phase 5 work begins until M3 lands.

## Phase 4 alignment — module surface

The post-M audit's resolutions imply runtime surface changes. M3 is the implementation contract that brings M1 + M2's runtime back in line with F2.

- [M3-module-surface-alignment.md](M3-module-surface-alignment.md) — Per-key state-file layout, `key` parameter on every module-state API function, `stateKeys` allowlist enforcement, `duplicatePolicy` on `appendToModuleState`, keyed-lookup `removeFromModuleState`. PortRegistry and the M1/M2 module-state tests update accordingly.

## Phase 5 — Resolution observability

User-facing extensibility (Phase 6) leans on the provenance reporting added here, so observability lands first.

- [O1-resolution-observability.md](O1-resolution-observability.md) — Startup log line, `gan config print`, discard reporting.

R1 already ships a minimum-viable observability surface in Phase 2 (the orchestrator startup log line described in [O1's part A](O1-resolution-observability.md): which files were loaded, which stacks are active, which tier each stack came from). Phase 5 adds the richer surfaces (`gan config print`, `--print-config` JSON, `discarded` array reporting). This split lets early users debug overlay and detection issues from Phase 2 onward without waiting for the full observability suite.

## Phase 6 — User-facing extensibility

Hands-on customisation surface.

- [U1-project-overlay-ux.md](U1-project-overlay-ux.md) — Hand-editable `.claude/gan/project.md`, validation errors, examples, mental-model guide.
- [U2-user-overlay-ux.md](U2-user-overlay-ux.md) — `~/.claude/gan/config.md`, cross-project preferences, auto-memory integration.
- [U3-additional-context-splice.md](U3-additional-context-splice.md) — `additionalContext` splice points for planner/proposer.

## Phase 7 — Recovery

- [O2-recovery.md](O2-recovery.md) — Per-run state archive, `--recover`, `--list-recoverable`. Reconceived for F1 zones and F2 API; lands after E1 so the agent integration pattern is in place.

## Deferred — additional real-ecosystem stacks

Authored, reviewed, and intentionally postponed until the active plan has shipped and seen real use. See [`specifications/deferred/README.md`](deferred/README.md) for reactivation criteria.

- [deferred/S1-android-stack.md](deferred/S1-android-stack.md) — Android client stack file.
- [deferred/S2-kmp-stack.md](deferred/S2-kmp-stack.md) — Kotlin Multiplatform stack file.
- [deferred/S3-ios-swift-stack.md](deferred/S3-ios-swift-stack.md) — iOS Swift / SwiftUI stack.

The risk these specs were originally meant to mitigate — that the framework calcifies around web-node — is addressed in the active plan by the multi-stack guard rail principle below: a synthetic fixture-only stack, a `lint-no-stack-leak` script, and a cross-stack capability assertion in E3.

## Bite-size sizing

Every spec aims to be small enough that one sprint of focused work delivers a complete, mergeable result. Sprint-level slicing within a spec is noted in each spec's "Bite-size note" section.

## Cross-cutting principles

- **The Configuration API is a black box.** Agents know function names; they do not know storage, schemas, or merge logic. Specs F2 and R1 own the contract.
- **Maintainer tooling assumes Node 18+.** User-facing behavior is owned by the agent at runtime. iOS, embedded C++, Swift-only developers never need Node to use `/gan`.
- **Pre-1.0 WIP project.** No backward-compatibility guarantees; any schema change bumps `schemaVersion`. No transitional dual-path windows.
- **CI workflow structure** locked to one file per test category plus a shared reusable workflow: `.github/workflows/{shared-setup,test-modules,test-evaluator-pipeline,test-stack-lint,test-schemas,test-no-stack-leak,test-error-text}.yml`. New categories follow `test-<category>.yml`.
- **Module ↔ stack name pairing** is enforced by the Configuration API at registration time. No separate lint subsystem needed.
- **Single-canonical stacks at the repo, plural at the project.** The repo promotes exactly one stack file per ecosystem. Users who want to diverge fork the file into their project tier (`.claude/gan/stacks/<name>.md`); C5's three-tier resolution makes that a one-line operation. There is no central N-versions registry, no curation queue, no community-vote process — PRs against the canonical file are the curation pipeline. This applies to the bootstrap stacks (`web-node`, plus the synthetic guard-rail fixture) and to any future ecosystem reactivated from `specifications/deferred/`. The scaffold (`gan stacks new`) is for users authoring project-tier customisations or contributing back upstream; both paths land in the same single-canonical model.
- **Replacement, not migration.** This spec set describes a different architecture, not a refactor of the existing implementation. The current code (5 agent prompts under `agents/`, `skills/gan/SKILL.md`, `skills/gan/schemas/*.json`, `install.sh`) shares almost nothing structural with the new system: different filesystem layout (`.gan/` → three zones), different validation model (free-form prompts → black-box API), different language (markdown prompts → Node MCP server). Trying to "migrate" means compromise; "delete and start clean" loses domain knowledge embedded in the old prompts. The pattern is **extract-and-replace**: build new from spec, mine old prompts for content during E2, retire old artifacts as the specs that supersede them land.

  **Cleanup discipline.** Every implementation PR for a spec that retires old artifacts must delete those artifacts **in the same PR**. The retirement is part of the spec, not a follow-up. Lingering legacy is forbidden — dead prompts are especially dangerous because prompts compose by inclusion (a stale agent file may be picked up by search, by future authoring, or by a tool that scans `agents/`). The "Retirement table" below names every old artifact and the spec that retires it.

- **Multi-stack guard rail.** The active plan ships exactly one real ecosystem stack (`web-node`). To prevent the framework from calcifying around web-node assumptions while only one real stack exists, three mechanisms run together:
  1. A **synthetic fixture-only stack** (`tests/fixtures/stacks/synthetic-second/.claude/gan/stacks/synthetic-second.md`) lives in-tree from R1's first sprint slice. It is not a real ecosystem; it is a minimal stack that exercises every C1 schema field, both detection composites (`allOf` and `anyOf`), the cacheEnv conflict path, the securitySurfaces keyword + scope path, and `lintCmd.absenceSignal`. It is referenced from no production code path; its sole purpose is to be the "second stack" multi-stack code paths must work for.
  2. A **`lint-no-stack-leak` script** (R4) forbids web-node-specific identifiers (`package.json`, `node_modules`, `npm`, `pnpm`, `yarn`, `lockfile`, `.nvmrc`, etc. — the full list lives in R4 alongside the script) anywhere outside `stacks/web-node.md`, `tests/fixtures/stacks/js-ts-minimal/`, and explicitly-allowlisted maintainer-tooling files. Hits the script as a CI gate (`test-no-stack-leak.yml`).
  3. A **cross-stack capability assertion** in E3: the harness runs the synthetic stack's evaluator-plan fixture and asserts the deterministic core produces the expected output for it, side-by-side with `js-ts-minimal/`. Any framework change that breaks multi-stack semantics fails this check.

  The three together make it physically impossible for the framework to regress to single-stack without breaking CI. When a deferred S-series spec is reactivated, the synthetic stack and its supporting machinery stay — they remain a guard rail against a post-1.0 framework drifting toward whichever stacks happen to dominate its real-world use.

## Retirement table

Single canonical inventory of every old artifact retired during the redesign. Each row names the artifact, the spec whose implementation retires it, and the retirement mechanism. Implementation PRs for the listed specs are **incomplete** if the named artifacts survive — the PR's diff must show them as `D` (deleted) or `M` (modified, full replacement).

Two retirement mechanisms appear in the table:

- **`M` (rewrite in place):** the file survives at the same path; its contents are fully replaced by the new spec. The implementation PR's diff shows a `M` entry for the path, with most or all of the file's content changed. Old behavior at that path is gone after the PR lands.
- **`D` (delete):** the file is removed entirely. The implementation PR's diff shows a `D` entry. Whatever the old file did has either moved to a different path (with attribution) or been retired without replacement.

| Old artifact | Retired by | Mechanism |
|---|---|---|
| `agents/gan-planner.md` | E1 | `M` — rewritten in place. New content consumes `getResolvedConfig()` instead of reading `.gan/` files. |
| `agents/gan-contract-proposer.md` | E1 | `M` — rewritten in place. Hardcoded checklist content lifts to stack-file `securitySurfaces` per E2; nothing remains in the prompt. |
| `agents/gan-contract-reviewer.md` | E1 | `M` — rewritten in place. New content consumes the snapshot; old `.gan/` reads removed. |
| `agents/gan-generator.md` | E1 | `M` — rewritten in place. |
| `agents/gan-evaluator.md` | E1 | `M` — rewritten in place. The hardcoded stack-specific tokens are processed per E2's extraction audit: tokens belonging to a shipped stack (`npm audit`, web/Node security surfaces) move into `stacks/web-node.md`; tokens belonging to off-plan ecosystems (`kt`, `kts`, `gradle`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, etc.) are either retained as synthetic-second fixture content or explicitly retired-not-lifted in E2's PR audit. The rewritten prompt contains zero stack-specific tokens, verified by R4's `lint-no-stack-leak`. |
| `skills/gan/SKILL.md` | E1 | `M` — rewritten in place. The 557-line existing file's flow (Step 0 / 0.5 / 0.75 / 1 / 2a / 2b / 3) is replaced wholesale; the new orchestrator calls `validateAll()` first, captures the snapshot once, and consumes the API. Not a refactor — full content replacement. |
| `skills/gan/gan` | E1 | `D` — broken symlink; dead artifact. |
| `skills/gan/schemas/{contract,feedback,objection,progress,review,telemetry-summary}.schema.json` | E1 | `D` — these run-state schemas describe per-run state inside the old orchestrator. The rewritten orchestrator either re-authors them under a new location consistent with F1's zones (e.g. `schemas/run-state/<type>-v1.json` per F3's naming) **or** drops them if the new flow no longer validates against the same shapes. Either path requires deleting the originals: leaving them at the old path implies the old SKILL.md is still loading them. The E1 PR must commit to one of the two paths and execute it. |
| `install.sh` (existing 138-line `.gan/`-based installer) | R2 | `M` — rewritten in place. Same path, full content replacement implementing R2's spec. No transition period. |
| `.gan/` directory contract (in code) | F1 + E1 | F1 specifies the new zones (the contract). E1's PR removes every code reference to `.gan/` from the rewritten orchestrator and prompts. User-side `.gan/` state in user repos is documented in R2's installer (and release notes) as "delete by hand; start fresh" — pre-1.0 + no-backward-compat. |
| Hardcoded stack-specific knowledge inside agent prompts | E1 + E2 | E1's rewrite physically removes the tokens from the prompts. E2 verifies at extraction time that every stack-specific concept has a home in `stacks/<name>.md` — anything dropped is explicitly listed as "retired, not lifted" in the E2 PR's body. R4's `lint-no-stack-leak` is the permanent backstop scanning agent prompts and core code for ecosystem tokens outside their owning stack files. |
| `README.md` (existing 214-line description of the old `.gan/`-based architecture) | E1 | `M` — rewritten in place. The README is the most user-visible piece of legacy in the working tree (`git clone`'s first impression); after E1 the framework operates fundamentally differently and the README must reflect that. Same E1 PR that lands the orchestrator rewrite. |
| `.gitignore` at repo root (currently lists only `.DS_Store` and review correspondence) | F1 | `M` — F1's first implementation sprint adds `.gan-state/` and `.gan-cache/` entries so the new zones are gitignored from the moment they exist. Without this, a developer's first `/gan` run on the new architecture commits zone-2 run state into git. |

**Note on the run-state schema decision.** Six rows above (`skills/gan/schemas/{contract,feedback,objection,progress,review,telemetry-summary}.schema.json`) defer the rewrite-or-drop choice to the E1 PR. Whichever path is chosen — re-author at `schemas/run-state/<type>-v1.json` per F3, or drop entirely — the Retirement table is amended in the same PR with the actual destination so the row reads as a finished decision rather than a TODO. Future readers see the choice that was made, not the choice that was deferred.

**Verification.** When the named spec lands, the PR's reviewer checks the diff against the corresponding rows. Any survival is grounds for blocking the merge until the retirement is complete. After the spec lands, a periodic audit (`grep -r 'gan-evaluator\|gan-planner\|...' .` for the old-artifact names; the survival of the symlink as a broken pointer; etc.) catches anything that crept back. Dead-code rot is the failure mode this discipline closes.

**Branch strategy.** Build on `feature/stack-plugin-rfc` through at least Phase 3 (the cutover). Don't merge to main mid-pivot — main on the old branch is functional, mid-pivot main would carry both architectures simultaneously. Merge to main when Phase 3 closes (the post-E1 revision break is the natural gate). At that point the old artifacts are gone from the working tree; git history retains them for archeological reference.

**O2's prescriptive revision rides the same merge.** The post-E1 revision break opens after E1's implementation lands on the feature branch and closes before Phase 3 merges to main. O2's first prescriptive authoring happens *inside* that break, not after it — so the merge to main carries both E1's cutover and O2's revised recovery flow as a unit. There is no transitional state where E1 is merged but O2 is still descriptive-only; the break does not close until O2's prescriptive revision lands.

## Out of scope for this roadmap

- Cross-run learning / auto-curated project memory. `/gan` stays a reader of documented overlay files; it never writes durable project knowledge.
- Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery. Users opt in explicitly via `additionalContext` (U3).
- Real-ecosystem stacks beyond `web-node`. The deferred S-series specs (Android, KMP, iOS Swift) capture a starting point; reactivation is gated by the criteria in [`specifications/deferred/README.md`](deferred/README.md). Desktop and embedded stacks follow the same template if and when the pattern is proven on a second real ecosystem.

## Runtime knobs

Single inventory of every flag, env-var value, and prompt branch a user can hit at runtime. Authoritative — individual specs reference this table rather than restating their own surfaces. New knobs land here in the same PR that adds them.

**On flag duplication.** `--help` appears in the surface table for `/gan` (E1), `install.sh` (R2), and `gan` (R3). The sigil is shared; the implementation is per-spec. There is no single authoritative `--help` — each command surface owns its own help text and exit-code contract, by design (different commands have different things to say). Where this table counts surfaces, `--help` is counted once by sigil per the surface-count rule documented at the bottom of this section.

### Top-level commands

| Surface | Owning spec | Effect |
|---|---|---|
| `/gan` (bare) | E1 | Run a sprint against the current project. |
| `gan` (bare) | R3 | Print top-level help (alias of `gan --help`). |
| `install.sh` (bare) | R2 | Install ClaudeAgents into the current Claude Code environment. |

### `/gan` skill flags

| Flag | Owning spec | Effect | Pre-`validateAll()` short-circuit? |
|---|---|---|---|
| `--help` / `-h` / `help` | E1 | Print help, exit. | Yes — only flag that runs before `validateAll()`. |
| `--print-config` | O1 | Emit resolved-config snapshot via O1's surface; exit. `validateAll()` runs in **non-aborting** mode (partial snapshot + structured errors on failure). | No (validateAll runs but does not abort). |
| `--recover` | O2 | Resume a previously-aborted run. Mechanism prescriptively authored at the post-E1 break. | No (validateAll runs in non-aborting mode). |
| `--list-recoverable` | O2 | List archived recoverable runs; exit. | No (validateAll runs in non-aborting mode). |
| `--no-project-commands` | F4 | Run with all project-declared commands suppressed. Recommended when reviewing someone else's branch. | No. |

### `install.sh` flags

| Flag | Owning spec | Effect |
|---|---|---|
| `--help` / `-h` | R2 | Print help, exit 0. |
| `--uninstall` | R2 | Reverse the install (remove symlinks + MCP config entry; leave filesystem zones intact). |
| `--no-claude-code` | R2 | Install in CI/headless environments that have Node + git but no Claude Code; `gan` CLI works, `/gan` skill is unavailable. |

### `gan` CLI subcommands

| Subcommand | Owning spec | Effect |
|---|---|---|
| `gan validate` | R3 | Run `validateAll()` and print a report. |
| `gan config print` | R3 | Print the full resolved config (use `--json` for raw). |
| `gan config get <path>` | R3 | Print one resolved value at a dotted path. |
| `gan config set <path> <value>` | R3 | Update one splice point at the named tier. |
| `gan stacks list` | R3 | List active stacks with tier provenance. |
| `gan stacks new <name>` | R3 | Scaffold a stub stack file (DRAFT-bannered until user removes). |
| `gan stack show <name>` | R3 | Print one stack's full data. |
| `gan stack update <name> <field> <value>` | R3 | Update one field of a stack file. |
| `gan modules list` | R3 | List registered modules + `pairsWith` status. |
| `gan trust info` | R5 | Show approval status + declared command-paths. Reminder that the trust hash does not transitively cover scripts. |
| `gan trust approve` | R5 | Approve the current content hash for the named project. Trust-mutating; `--project-root` required. |
| `gan trust revoke` | R5 | Remove approval for the named project. Trust-mutating; `--project-root` required. |
| `gan trust list` | R5 | List all current approvals. |
| `gan version` | R3 | Print API version, server version, schemas in use. |
| `gan help` / `gan --help` / `gan -h` | R3 | Print top-level help (one help surface; aliases for muscle-memory). |

### `gan` CLI flags

| Flag | Scope | Owning spec | Effect |
|---|---|---|---|
| `--help` / `-h` | every subcommand | R3 | Print subcommand help, exit 0. |
| `--json` | reads | R3 | Emit raw API JSON instead of human format. |
| `--project-root=<path>` | global | R3 | Project root override. Trust-mutating subcommands require this explicitly. |
| `--tier=project\|repo` | `gan stacks new` | R3 | Scaffold target tier; default `project`. |
| `--note=<text>` | `gan trust approve` | R5 | Note attached to approval (free text; user-visible in `gan trust list`). |

### Environment variables

| Var | Values | Owning spec | Effect |
|---|---|---|---|
| `GAN_TRUST` | unset / `strict` / `unsafe-trust-all` | F4 | Trust mode. Unset = interactive prompt on `UntrustedOverlay`. `strict` = fail closed (no prompt; CI default). `unsafe-trust-all` = bypass trust check (development convenience; never in CI). |

### Trust prompt branches (interactive UI)

The trust prompt has one render with two content variants (subsequent-change vs. initial-introduction), four action branches:

| Branch | Action | Owning spec |
|---|---|---|
| `[v]` | View — diff for subsequent-change, command-list for initial-introduction. | F4 |
| `[a]` | Approve and run; writes `(projectRoot, contentHash)` to the trust cache. | F4 |
| `[r]` | Run with `--no-project-commands` (skip project-defined commands); does not write to cache. | F4 |
| `[c]` | Cancel; abort the run. | F4 |

### Surface-count rule and inventory

**Rule.** Each unique `(surface-type, name)` pair counts once. Surface-type ∈ {command, subcommand, flag, env-var-value, prompt-branch}. Multi-word subcommands count as one (`gan trust approve` = one entry). Flags count by sigil string, deduplicated globally — `--help` appears under three commands but counts once. Aliases of the same flag (`--help` / `-h` / `help`) count as one surface, not three. Prompt branches count per unique action key, not per render variant.

**Post-trim inventory (current):**

| Surface-type | Count | Members |
|---|---|---|
| command | 3 | `/gan`, `gan`, `install.sh` |
| subcommand | 15 | `validate`, `config print`, `config get`, `config set`, `stacks list`, `stacks new`, `stack show`, `stack update`, `modules list`, `trust info`, `trust approve`, `trust revoke`, `trust list`, `version`, `help` |
| flag | 11 | `--help`, `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`, `--uninstall`, `--no-claude-code`, `--json`, `--project-root`, `--tier`, `--note` |
| env-var-value | 2 | `GAN_TRUST=strict`, `GAN_TRUST=unsafe-trust-all` |
| prompt-branch | 4 | `[v]`, `[a]`, `[r]`, `[c]` |
| **total** | **35** | |

Pre-trim baseline was 43 (`gan trust export`/`import` and `gan migrate-overlays` as subcommands; `--out`, `--no-notes`, `--to`, `--force` as flags; `GAN_TRUST=approved-hashes-only` as env-var value). The trim removed exactly the 8 surfaces projected.

When this table grows, the surface count grows with it. New knobs require explicit roadmap-table editing as part of the PR; specs do not own surfaces independently.

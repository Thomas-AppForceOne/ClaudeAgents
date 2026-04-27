# ClaudeAgents — Roadmap

## End state

ClaudeAgents is a framework for AI-driven software development workflows — sprint planning, code generation, review, verification — that works on any technology stack. When this redesign is fully shipped, a developer in any ecosystem (Swift on iOS, Kotlin on Android, embedded C++, Python, Rust, web/node, and more) installs ClaudeAgents once, restarts Claude Code once, and `/gan` operates on their project. Adding support for a new ecosystem is a file drop, not a code change. Node is required once at install time (the framework is distributed via npm); after install, daily workflow on a non-Node ecosystem never touches Node.

The architectural backbone is a **Configuration API** that hides storage, validation, and merging behind a small set of named functions. Agents call those functions; they do not parse files, do not know schemas, and do not enumerate tiers. Stack files declare per-ecosystem behavior; overlays apply per-user and per-project customization through a cascading merge; runtime utility libraries (modules) provide imperative helpers paired by name with their stack files. The project filesystem is split into config, durable state, and cache zones with non-overlapping lifecycles, so persistent module state cannot collide with per-run orchestration data. Configuration files are hand-editable; the API validates on read and surfaces structured errors when something is wrong.

The phases below trace the implementation path from foundations outward. Each spec is sized for a single sprint of focused work.

## How to read the spec set

Specs are organised by **phase code** (F = foundation, C = configuration domains, R = reference implementation, E = agent integration, M = modules, S = new stacks, U = user-facing extensibility, O = observability and operations). Filenames carry the phase code so directory listings show the natural execution order. Foundations land before consumers; reference implementations land before refactors that use them; observability lands last.

## Phase 0 — Foundations

System contracts that every later spec depends on.

- [F1-filesystem-layout.md](F1-filesystem-layout.md) — Three project zones (`.claude/gan/`, `.gan-state/`, `.gan-cache/`) with single-owner lifecycles. Retires the old `.gan/` directory.
- [F2-config-api-contract.md](F2-config-api-contract.md) — Black-box function surface, MCP binding, validation timing, install/restart story, error model.
- [F3-schema-authority.md](F3-schema-authority.md) — JSON Schema location, `schemaVersion` semantics, lint integration.

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
- [R4-maintainer-tooling.md](R4-maintainer-tooling.md) — Lint script, schema publisher, capability-check runner, CI workflows.

## Revision break — post-R contract audit

The R series is the first time the F-phase contracts and C-phase data models are exercised against real code (the MCP server, installer, CLI, lint). Before Phase 3 begins, every contract spec is re-audited against its implementation to surface gaps the spec missed.

Specs to revisit, with what to verify:

- **F2** — confirm the function surface and structured-error model match what R1 actually exposes; refine signatures, error codes, and bulk-read shapes if implementation surfaced different patterns.
- **F3** — confirm the JSON Schema documents at `schemas/<type>-vN.json` cover everything R1 needs to validate; add fields or invariants the implementation found necessary.
- **C1, C2, C3, C4, C5** — confirm the algorithms and merge rules described match what R1's resolver actually does; clarify ambiguities found during implementation.

Like the post-E1 break, this is a checkpoint: specs are revised in place; no new files. No Phase 3 work begins until the audit closes.

## Phase 3 — Agent integration

Existing agents start using the new system.

- [E1-agent-integration.md](E1-agent-integration.md) — Orchestrator and agent prompt rewrites. SKILL.md, gan-planner, gan-contract-proposer, gan-generator, gan-evaluator, gan-recover all consume the Configuration API instead of parsing files. Single coordinated PR with per-agent sprint slices.
- [E2-builtin-stack-extraction.md](E2-builtin-stack-extraction.md) — Extract web-node, python, rust, go, ruby, kotlin, gradle, generic into `stacks/<name>.md` files written via the API.
- [E3-capability-test-harness.md](E3-capability-test-harness.md) — Fixtures, golden files, normalisation rules, the `scripts/capability-check` reference implementation.

**Implementation order within Phase 3 (numbering is "spec authored first," not implementation order):** E1 (orchestrator + agent rewrites) → E3 (harness + bootstrap fixtures) → E2 (extract built-in stacks under the harness). E2 is gated by E3 per E2's own text; E3 cannot test the rewrites until E1 lands.

## Revision break — post-E1 audit + O2 first prescriptive revision

E1 is the largest behavioral change in the roadmap and several downstream specs reference its outcome without yet knowing the concrete details. Before continuing past Phase 3, every spec that carries an "E1 dependency" note is re-audited against E1's actual implementation. Most are revised in place. **O2 gets its first prescriptive authoring here — not just an audit.**

Specs to revisit, with what to verify:

- **O1** — confirm the orchestrator's startup-log shape matches what E1's coordinator actually emits; refine output format if needed.
- **O2** — full reconception of the recovery flow under F1's zone layout and E1's snapshot model. The current spec is explicitly marked "descriptive of intent, not prescriptive"; this is where it becomes prescriptive. Real authoring work, not editing.
- **S1, S2** — validate that contract-proposer and evaluator behavior described in acceptance criteria matches what the rewritten agents do; update criteria if E1 surfaced different patterns.
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
- **M1** — refine the lifecycle prose if M2 implementation surfaced timing/sequencing details the architecture spec missed.

Same checkpoint discipline as the other revision breaks: specs revised in place; no Phase 5 work begins until the audit closes.

## Phase 5 — New stacks

Apply the system to ecosystems beyond the bootstrap set.

- [S1-android-stack.md](S1-android-stack.md) — Android client stack file.
- [S2-kmp-stack.md](S2-kmp-stack.md) — Kotlin Multiplatform stack file.
- [S3-ios-swift-stack.md](S3-ios-swift-stack.md) — iOS Swift / SwiftUI stack.

## Revision break — post-S schema audit

Phase 5 lands three concrete, real-world stack files (Android, KMP, iOS) that exercise C1's schema against ecosystems the framework was not initially designed around. If any stack needed a workaround, omitted a useful concept, or stretched a field beyond its intended use, that's a signal that C1's schema needs an extension.

Specs to revisit, with what to verify:

- **C1** — confirm every field used by S1, S2, S3 was usable as designed. If a stack needed a new field shape (composite detection variants, additional securitySurface trigger types, scheme/destination placeholders for iOS), land it here as a schema bump rather than as per-stack workarounds.
- **C2** — confirm the detection algorithm handles the realistic detection composites the three stacks declare without ambiguity.
- **F3** — bump `schemas/stack-vN.json` if C1's shape changed.

This is a checkpoint: specs are revised in place; no new files. No Phase 6 work begins until the audit closes.

## Phase 6 — Resolution observability

User-facing extensibility (Phase 7) leans on the provenance reporting added here, so observability lands first.

- [O1-resolution-observability.md](O1-resolution-observability.md) — Startup log line, `gan config print`, discard reporting.

## Phase 7 — User-facing extensibility

Hands-on customisation surface.

- [U1-project-overlay-ux.md](U1-project-overlay-ux.md) — Hand-editable `.claude/gan/project.md`, validation errors, examples, mental-model guide.
- [U2-user-overlay-ux.md](U2-user-overlay-ux.md) — `~/.claude/gan/config.md`, cross-project preferences, auto-memory integration.
- [U3-additional-context-splice.md](U3-additional-context-splice.md) — `additionalContext` splice points for planner/proposer.

## Phase 8 — Recovery

- [O2-recovery.md](O2-recovery.md) — Per-run state archive, `--recover`, `--list-recoverable`. Reconceived for F1 zones and F2 API; lands after E1 so the agent integration pattern is in place.

## Bite-size sizing

Every spec aims to be small enough that one sprint of focused work delivers a complete, mergeable result. Sprint-level slicing within a spec is noted in each spec's "Bite-size note" section.

## Cross-cutting principles

- **The Configuration API is a black box.** Agents know function names; they do not know storage, schemas, or merge logic. Specs F2 and R1 own the contract.
- **Maintainer tooling assumes Node 18+.** User-facing behavior is owned by the agent at runtime. iOS, embedded C++, Swift-only developers never need Node to use `/gan`.
- **Pre-1.0 WIP project.** No backward-compatibility guarantees; any schema change bumps `schemaVersion`. No transitional dual-path windows.
- **CI workflow structure** locked to one file per test category plus a shared reusable workflow: `.github/workflows/{shared-setup,test-modules,test-capability}.yml`. New categories follow `test-<category>.yml`.
- **Module ↔ stack name pairing** is enforced by the Configuration API at registration time. No separate lint subsystem needed.

## Out of scope for this roadmap

- Cross-run learning / auto-curated project memory. `/gan` stays a reader of documented overlay files; it never writes durable project knowledge.
- Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery. Users opt in explicitly via `additionalContext` (U3).
- Desktop and embedded stacks beyond what S1–S3 demonstrate. Follow the same template once the pattern is proven.

# ClaudeAgents — Roadmap

Specs are organised by **phase code** (F = foundation, C = configuration domains, R = reference implementation, E = agent integration, M = modules, S = new stacks, U = user-facing extensibility, O = observability and operations). Filenames carry the phase code so directory listings show the natural execution order.

The Configuration API is the architectural backbone: agents access framework state only through it; storage details are a black box behind it. Foundations land before consumers; reference implementations land before refactors that use them; observability lands last.

## Phase 0 — Foundations

System contracts that every later spec depends on.

- [F1-filesystem-layout.md](F1-filesystem-layout.md) — Three project zones (`.claude/gan/`, `.gan-state/`, `.gan-cache/`) with single-owner lifecycles. Retires the old `.gan/` directory.
- [F2-config-api-contract.md](F2-config-api-contract.md) — *Stub.* Black-box function surface, MCP binding, validation timing, install/restart story, error model.
- [F3-schema-authority.md](F3-schema-authority.md) — *Stub.* JSON Schema location, `schemaVersion` semantics, lint integration.

## Phase 1 — Configuration domains

Data models the API exposes.

- [C1-stack-plugin-schema.md](C1-stack-plugin-schema.md) — Stack file schema, detection composites, parse contract.
- [C2-stack-detection-and-dispatch.md](C2-stack-detection-and-dispatch.md) — Dispatch algorithm, scope filtering, generic fallback.
- [C3-overlay-schema.md](C3-overlay-schema.md) — Overlay splice points, defaults, `discardInherited`.
- [C4-three-tier-cascade.md](C4-three-tier-cascade.md) — default → user → project merge per splice point.
- [C5-stack-file-resolution.md](C5-stack-file-resolution.md) — project → user → repo lookup for stack files.

## Phase 2 — Reference implementation

The MCP server and tooling that fulfill Phases 0–1.

- [R1-config-mcp-server.md](R1-config-mcp-server.md) — *Stub.* Node 18+ MCP server implementing F2.
- [R2-installer.md](R2-installer.md) — *Stub.* `install.sh`, MCP registration, zone preparation.
- [R3-cli-wrapper.md](R3-cli-wrapper.md) — *Stub.* `gan validate`, `gan config`, `gan stacks`.
- [R4-maintainer-tooling.md](R4-maintainer-tooling.md) — *Stub.* Lint script, schema publisher, capability-check runner, CI workflows.

## Phase 3 — Agent integration

Existing agents start using the new system.

- **E1 (agent prompt rewrite, no spec doc).** Rewrite gan-planner, gan-generator, gan-evaluator, gan-contract-proposer, SKILL.md, and O2's recovery flow to call the Configuration API instead of parsing files. Single coordinated PR.
- [E2-builtin-stack-extraction.md](E2-builtin-stack-extraction.md) — Extract web-node, python, rust, go, ruby, kotlin, gradle, generic into `stacks/<name>.md` files written via the API.
- **E3 (capability test harness, drafted alongside E2).** Fixtures, golden files, normalisation rules, the `scripts/capability-check` reference implementation. Ensures the agent rewrite preserves intended behavior.

## Phase 4 — Modules

Runtime utility libraries; independent of Phases 0–3 conceptually.

- [M1-modules-architecture.md](M1-modules-architecture.md) — *Pending rewrite.* Module install path, `pairsWith` enforcement via API, distribution. Today's MODULES_ARCHITECTURE.md content; full rewrite scheduled.
- [M2-docker-module.md](M2-docker-module.md) — *Stub.* PortRegistry, PortDiscovery, ContainerHealth, PortValidator, ContainerNaming. Persists state in `.gan-state/modules/docker/`.

## Phase 5 — New stacks

Apply the system to ecosystems beyond the bootstrap set.

- [S1-android-stack.md](S1-android-stack.md) — Android client stack file.
- [S2-kmp-stack.md](S2-kmp-stack.md) — Kotlin Multiplatform stack file.
- [S3-ios-swift-stack.md](S3-ios-swift-stack.md) — *Stub.* iOS Swift / SwiftUI stack.

## Phase 6 — User-facing extensibility

Hands-on customisation surface.

- **U1 (project overlay UX, drafted alongside C3).** Hand-editable `.claude/gan/project.md`, validation errors, examples.
- **U2 (user overlay UX, drafted alongside C4).** `~/.claude/gan/config.md`, cross-project preferences.
- [U3-additional-context-splice.md](U3-additional-context-splice.md) — `additionalContext` splice points for planner/proposer.

## Phase 7 — Observability and operations

- [O1-resolution-observability.md](O1-resolution-observability.md) — Startup log line, `gan config print`, discard reporting.
- [O2-recovery.md](O2-recovery.md) — Per-run state archive, `--recover`, `--list-recoverable` (updated for F1 zones and F2 API).

## Bite-size sizing

Every spec aims to be small enough that one sprint of focused work delivers a complete, mergeable result. Where a spec covers multiple concerns (currently C3 and C4 mix schema with UX), a future content commit splits it. Sprint-level splits are noted at the end of each spec's "Bite-size note" or status banner.

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

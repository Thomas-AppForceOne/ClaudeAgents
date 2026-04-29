# M1 — Modules architecture

## Problem

Stack files (C1) are declarative — they describe what to scan, what to run, what surfaces to check. Agents and the orchestrator need to *do* things: spin up Docker containers, discover ports, check container health, manipulate Xcode project files, talk to a database. Some of this work is too imperative for a markdown declaration; it requires real code.

Modules are the imperative layer. Each module is a runtime utility library — code an agent imports and calls — paired with a stack file by name (the API enforces this; see F3's `pairsWith.consistency` invariant).

This spec defines what a module is, where it lives, how it is installed, and how it integrates with the Configuration API.

## Proposed change

### What a module is

A module is a Node 18+ library exporting a defined surface. Each module:

- Lives at `src/modules/<name>/` in the ClaudeAgents repo.
- Exports a barrel (`index.js`) that performs prerequisite checks and re-exports utilities.
- Reads its declarative configuration through the Configuration API (`getModuleState`, `getResolvedConfig`); it does not parse files directly.
- Persists durable runtime state under `.gan-state/modules/<name>/` (zone 2 per F1) by writing through `setModuleState()`.
- Declares its identity in a `manifest.json` validated against `schemas/module-manifest-v1.json`.

The manifest looks like:

```json
{
  "name": "docker",
  "schemaVersion": 1,
  "pairsWith": "docker",
  "description": "Container and port management for git worktree workflows.",
  "prerequisites": [
    {"command": "docker --version", "errorHint": "Install Docker Desktop or Docker Engine."}
  ],
  "exports": ["PortRegistry", "PortDiscovery", "ContainerHealth", "PortValidator", "ContainerNaming"],
  "stateKeys": ["port-registry"],
  "configKey": "docker"
}
```

### Lifecycle

1. **Build time.** The module's manifest is committed alongside its code. `scripts/lint-stacks` and `scripts/pair-names` (R4) check that manifests are valid and `pairsWith` is consistent.
2. **Install time.** `install.sh` (R2) makes the module's code available to agents (npm-link or per-package install; details in R2).
3. **Registration time.** When the Configuration MCP server starts, it discovers each module via its manifest and calls `registerModule()` (F2) to record it. The API rejects registration on a `pairsWith` collision; the failure surfaces as a structured error.
4. **Runtime.** An agent imports the module's barrel. The barrel runs prerequisite checks (e.g. `docker --version`); failures throw at import. The agent uses the exported utilities. **Cost note for the post-M revision break:** at v1 with two shipped modules this is fine, but barrel-runs-prerequisites scales O(N) in shipped modules even on projects whose paired stack is inactive. An iOS-only project paying `docker --version` at every `/gan` startup is acceptable today, awkward at five shipped modules, and a real complaint at twenty. Post-M audit revisits whether prerequisites should run lazily on first export use, gated by paired-stack activation, or some other shape — flagged here so the audit catches it deliberately rather than discovering the cost when it's already large.
5. **Persistence.** The module reads/writes durable state via `getModuleState()` / `setModuleState()`. It never writes files outside `.gan-state/modules/<name>/`. It never writes to zone 1 or zone 3.

### Pairing with stacks

A module's `pairsWith: <name>` declares that this module belongs alongside `stacks/<name>.md`. The API enforces:

- If `stacks/<name>.md` exists at any tier, its `pairsWith` field (when present) must match this module's name.
- A module may exist without a paired stack file (some modules provide tooling that no stack needs to declare). In that case `pairsWith` may be omitted.
- A stack file's `pairsWith` reference to a module that doesn't exist is a hard error.

Pairing is the only structural link between layers. Modules know nothing about agent prompts; agents know nothing about module internals.

### Configuration

A module's project-specific configuration (e.g. Docker's `containerPattern`, `fallbackPort`) lives at `.claude/gan/modules/<name>.yaml` (zone 1 per F1). Schema for these files is module-defined: each module spec declares its own JSON Schema as `schemas/module-config-<name>-vN.json`.

Modules read their config via `getResolvedConfig().modules.<name>`. They never parse `.yaml` files directly.

### Distribution

Modules ship inside the ClaudeAgents npm package (`@claudeagents/config-server`). Adding a new module is a contribution to the framework repo, not a separate distribution channel.

If a future need arises for third-party modules outside the ClaudeAgents repo, that's a new spec; this version handles only first-party modules.

### Prerequisite handling

A module's `prerequisites` array lists shell commands that must succeed for the module to load. If any fails, the barrel throws at import with the manifest's `errorHint`.

Agents using a module catch the import error and either:
- Fall back to non-module behavior, or
- Raise a structured blocking concern citing the missing prerequisite.

The framework does not auto-install module prerequisites.

### Module ↔ filesystem boundaries

| Zone | Module write access | Examples |
|---|---|---|
| Zone 1 (`.claude/gan/`) | **None.** Modules read config from this zone via the API. They never write. | `.claude/gan/modules/docker.yaml` |
| Zone 2 (`.gan-state/modules/<name>/`) | **Full ownership.** The module's exclusive workspace. | `.gan-state/modules/docker/port-registry.json` |
| Zone 3 (`.gan-cache/`) | **None.** Modules do not own caches. Build tools do. | n/a |

The recovery flow (O2) explicitly excludes `.gan-state/modules/` from archive operations; module-owned state outlives any single `/gan` run.

### What's not a module

- A stack file. Stacks are declarative config (C1). Modules are imperative code.
- An agent prompt. Agents (gan-planner, gan-evaluator, etc.) orchestrate sprints; modules are libraries they call.
- A skill. Skills are user-facing entry points (`/gan` is one). Modules are libraries skills and agents use.

## Acceptance criteria

- A module at `src/modules/<name>/` with a manifest and an `index.js` barrel can be added by dropping a directory; no other framework code changes.
- The Configuration MCP server discovers and registers each module on startup; conflicts (`pairsWith` collision) produce a structured error and prevent server start.
- A module reads its project config via `getResolvedConfig().modules.<name>`; the resolved value reflects `.claude/gan/modules/<name>.yaml` plus defaults.
- A module persists durable state under `.gan-state/modules/<name>/` via `setModuleState()`; nothing outside this directory is touched.
- The recovery flow (O2) leaves `.gan-state/modules/` untouched across all archive paths.
- A module's prerequisite check failure produces a clear import-time error including the manifest's `errorHint`.
- The lint pipeline (R4) catches `pairsWith` mismatches at build time, complementing the API's runtime enforcement.

## Dependencies

- F1 (filesystem zones)
- F2 (API contract — modules use `get/setModuleState`, `getResolvedConfig`, `registerModule`)
- F3 (schema authority — module manifest schema lives at `schemas/module-manifest-v1.json`)

## Bite-size note

This spec defines the architecture; concrete modules are separate specs (M2 Docker is the first). Authoring a new module: write the manifest, write the barrel + utilities, write per-utility tests, write the optional project-config schema. Each step is sprintable.

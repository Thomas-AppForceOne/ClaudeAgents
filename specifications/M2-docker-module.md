# M2 — Docker module

## Problem

Projects that run inside Docker containers have a recurring set of cross-cutting concerns when used with `/gan`'s git-worktree workflow:

- Each worktree needs its own container instance (otherwise concurrent runs collide).
- Each container needs a unique host port (otherwise the second one fails to bind).
- After a sprint completes, the right container needs to be stopped — not all containers, not the wrong one.
- Across runs and shell sessions, the framework needs to remember which port belongs to which worktree.
- Container health checks must distinguish "port bound" from "service responding."

The Docker module bundles these utilities so agents and orchestrators reuse one battle-tested implementation rather than reinventing the helpers per project.

## Proposed change

Add `src/modules/docker/` as the first concrete module under M1's architecture. Node 18+. Pairs with a future `stacks/docker.md` (when it exists; pairing is enforced by the API at registration time per M1).

### Layout

```
src/modules/docker/
  manifest.json
  index.js                  # barrel: prerequisite check + re-exports
  PortRegistry.js
  PortDiscovery.js
  ContainerHealth.js
  PortValidator.js
  ContainerNaming.js
  README.md                 # module-internal documentation
```

Tests live under `tests/modules/docker/` (one `*.test.js` per utility) and run via `node --test`.

### Manifest

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

### Project configuration

A project using the Docker module declares `.claude/gan/modules/docker.yaml`:

```yaml
schemaVersion: 1
containerPattern: "myapp-*"
fallbackPort: 8080
healthCheck:
  path: "/health"
  expectStatus: 200
  timeoutSeconds: 30
```

Schema lives at `schemas/module-config-docker-v1.json`. Modules read this via `getResolvedConfig().modules.docker`.

### Utilities

#### PortRegistry

Persists worktree → port + container-name mappings across runs.

```javascript
class PortRegistry {
  // The registry persists state at .gan-state/modules/docker/port-registry.json
  // via the Configuration API. Constructor takes no path argument; the module
  // owns its zone-2 location.
  register(worktreePath, port, containerName)
  lookup(worktreePath)        // → { port, containerName } or null
  getAll()                    // → array of all entries
  release(worktreePath)       // remove entry
}
```

State written through `setModuleState("docker", "port-registry", ...)`. The module is the sole writer of its registry; concurrent writes from two `/gan` runs are serialised through the Configuration MCP server.

#### PortDiscovery

Resolves a port for a container using a fallback chain.

```javascript
async function discoverPort(options) {
  // Layers, in order:
  // 1. options.envVar (if set and that env var is exported)
  // 2. PortRegistry lookup for the current worktree
  // 3. `docker ps --filter "name=<containerPattern>"` parsing
  // 4. options.fallbackPort
  // Throws if no port is discovered and no fallback is provided.
}
```

#### ContainerHealth

HTTP-level health check. Distinguishes "port bound" from "service ready":

```javascript
async function waitForHealthy(port, options) {
  // Polls http://localhost:<port><options.path> until expected status code.
  // Times out per options.timeoutSeconds. Returns true on success;
  // throws TimeoutError on failure with diagnostic detail (last response,
  // last error).
}
```

#### PortValidator

Platform-aware check that a port is free before binding:

- macOS: uses `lsof -i :<port>`.
- Linux: uses `ss -lnt sport = :<port>` (or `netstat` fallback).
- Windows: stub that throws `PlatformNotSupported`.

Used by `PortRegistry.register()` to refuse registering a port that's already in use by something the module didn't allocate.

**Platform support disclosure.** The Docker module is **macOS and Linux only** in v1. Windows users importing this module hit `PlatformNotSupported` on `PortValidator` and on any operation that depends on it. Per M1's prerequisite-handling rules, an agent catching this error either falls back to non-module behavior or raises a structured blocking concern. A future Windows-supported revision is out of scope for this spec.

#### ContainerNaming

Convention-driven container naming tied to worktree paths:

```javascript
function nameForWorktree(worktreePath, options) {
  // Returns a deterministic, container-safe string derived from the
  // worktree path's last segment plus a short hash. e.g.
  //   /Users/.../proj-worktree-a1b2c3 → "proj-worktree-a1b2c3-9f8e"
}
```

### Prerequisite check

`index.js` runs `docker --version` before re-exporting utilities. Failure throws with the manifest's `errorHint`. An agent catching this can either fall back or raise a blocking concern.

### Concurrency

Two `/gan` runs on the same machine, in different worktrees of the same project, can both use the Docker module without colliding because:

- Each worktree gets a different port (PortRegistry refuses duplicates; PortDiscovery picks a new one when needed).
- Each worktree gets a different container name (ContainerNaming is deterministic on worktree path).
- Registry writes go through the Configuration API, which serialises them.

### Recovery semantics

When a `/gan` run aborts, O2's recovery flow archives `.gan-state/runs/<run-id>/` but leaves `.gan-state/modules/docker/port-registry.json` intact. The next run sees the previous registry and can either reuse the port (worktree still alive) or release the entry (worktree gone).

### What this module does not do

- It does not build Docker images.
- It does not generate Dockerfiles or docker-compose configs.
- It does not orchestrate multi-container applications.
- It does not declare security surfaces (that's `stacks/docker.md`'s job, when it exists).

The module is utilities; the stack file (when authored) is policy.

## Acceptance criteria

- `src/modules/docker/manifest.json` validates against `schemas/module-manifest-v1.json`.
- The module registers with the Configuration MCP server on startup; `listModules()` reports it.
- Importing the module's barrel without Docker installed throws with the manifest's `errorHint`.
- `PortRegistry` persists state under `.gan-state/modules/docker/port-registry.json` via the Configuration API; reading the file directly bypasses the API but yields the same JSON.
- `PortDiscovery` resolves correctly from each layer of its fallback chain, validated by per-layer unit tests.
- `ContainerHealth.waitForHealthy()` succeeds on a healthy fixture container and throws a `TimeoutError` with diagnostic detail on a hung container.
- `PortValidator` correctly identifies a bound vs. free port on macOS and Linux; throws `PlatformNotSupported` on Windows.
- `ContainerNaming.nameForWorktree()` is deterministic for the same input and produces container-name-safe strings.
- O2's recovery flow against a fixture leaves `port-registry.json` byte-identical before and after.
- Two concurrent `/gan` runs on the same machine, same project, different worktrees do not collide on ports or container names.
- A fixture-only paired stack file at `tests/fixtures/stacks/docker-paired/.claude/gan/stacks/docker.md` declares `pairsWith: docker`, exercising the pairsWith resolution path end-to-end. The fixture is **test-only**: there is no shipped `stacks/docker.md` in v1, and no real ecosystem consumes the docker module yet. The fixture exists so M2's API is exercised against an actual paired stack file (rather than only against the unpaired-module path), surfacing pairing-logic gaps before the post-M revision break instead of at it. Shares the fixture-only-stack-file mechanism with `synthetic-second/`, but exercises the M1 pairsWith resolution path rather than C1 schema coverage — different test intents, same scaffolding pattern.

**API provisional until post-M reconciliation.** M2 ships before any real-ecosystem consumer of the docker module exists. Its API surface (`PortRegistry`, `PortDiscovery`, `ContainerHealth`, `PortValidator`, `ContainerNaming`) is **provisional**: the post-M revision break (per roadmap) is the explicit checkpoint at which this surface is reconciled against whatever a future canonical `stacks/docker.md` (if authored) or an actual agent's call-graph requires. Treat M2's API as exercising the module surface, not as locked-in for v1 stability.

## Dependencies

- F1 (filesystem zones — port-registry lives in zone 2)
- F2 (API contract — `get/setModuleState`, `getResolvedConfig`)
- F3 (schema authority — module-manifest and module-config schemas)
- M1 (modules architecture)

## Bite-size note

Five utilities, each independently sprintable. Recommend ordering:
1. PortRegistry (foundational; the others depend on it).
2. ContainerNaming (pure function, no external dependencies).
3. PortValidator (platform branching; isolated test surface).
4. PortDiscovery (composes the previous three).
5. ContainerHealth (composes none of the above; can land anytime).

Per-utility unit tests land alongside each utility commit. Integration tests against the recovery flow land last.

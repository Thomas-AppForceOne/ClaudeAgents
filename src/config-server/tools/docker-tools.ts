/**
 * Docker module MCP tool handlers — thin, lazy-loaded wrappers over the
 * shipped docker module library functions.
 *
 * The five handlers in this file each call exactly one shipped function from
 * `src/modules/docker/*`: `PortRegistry.register`, `PortRegistry.release`,
 * `discoverPort`, `waitForHealthy`, and `nameForWorktree`. No new domain
 * logic lives here — the file is a transport adapter that lets MCP-shaped
 * inputs flow into already-shipped library calls and lets the library's
 * errors flow back out verbatim. The dual-callable rule applies: a tool
 * import and a direct library import resolve to the same underlying
 * function, so the catalog tool and a direct library call produce equal
 * effects for equal inputs.
 *
 * Why every handler uses dynamic `import()` rather than a top-level
 * `import` from `../../modules/docker/*` — this is the load-bearing claim
 * of this module:
 *
 *   The docker module's barrel (`src/modules/docker/index.ts`) runs a
 *   side-effecting prerequisite check at import time (`docker --version`).
 *   A top-level static import of any file under `src/modules/docker/*`
 *   from the dispatch surface would execute that check at server startup
 *   and crash every config tool on every host without a `docker` binary.
 *   The dispatch surface must boot cleanly on a Docker-less host so that
 *   non-docker tools (`getResolvedConfig`, `validateAll`, etc.) remain
 *   callable; only the five docker tools surface the manifest `errorHint`
 *   when invoked. The dynamic `import()` inside each handler defers that
 *   side effect to first-call time per tool, satisfying the boot-without-
 *   Docker AC.
 *
 *   The same rule applies to `import type` — a type-only import is erased
 *   at runtime but is one eslint-friendly drift away from becoming a value
 *   import. The static-scan guard pins both forms as regressions, so this
 *   file declares all dynamic-import-returned shapes inline rather than
 *   pulling in a top-level type import.
 *
 * Why the handlers do not introduce a free-port allocator — the spec pins
 * caller-supplies-port semantics: collision avoidance comes from
 * `PortRegistry.register` throwing `PortInUse`, not from a scan-and-register
 * routine the tool layer would implement. A free-port allocator would be
 * new domain logic outside this contract; future work, not this one.
 *
 * Why the dynamic imports are wrapped in {@link importDockerModule} — a
 * Docker-less *host* is already handled (the prerequisite check fires when the
 * registry persists or `docker ps` spawns). But a module *absent on disk*
 * (a partial install, a pruned `dist/`) makes `import()` throw a bare
 * `ERR_MODULE_NOT_FOUND` that the dispatch surface would otherwise report as a
 * generic `NotImplemented`. The wrapper maps that one code to the spec-named
 * `ModulePrerequisiteFailed` carrying an actionable hint, so a missing module
 * surfaces the same class of error a missing prerequisite does; any other
 * import failure bubbles unchanged.
 */

import { createError } from '../errors.js';

// Module-not-found hint: distinct from the manifest's "install Docker" hint
// because the fault here is the docker module's own files missing on disk,
// not the Docker engine being absent. The remediation is to reinstall/rebuild
// the package, not to install Docker.
const DOCKER_MODULE_MISSING_HINT =
  'The docker module is not present on disk (a partial install or pruned ' +
  "build). Reinstall the package or run the build so 'dist/modules/docker/*' " +
  'exists.';

/**
 * Run a dynamic `import()` of a docker-module file, translating the
 * module-absent-on-disk failure into the actionable
 * `ModulePrerequisiteFailed` error.
 *
 * Only `ERR_MODULE_NOT_FOUND` (the module file is missing) is translated —
 * that is the partial-install / pruned-`dist` case. Every other failure
 * (syntax error in the module, a downstream prerequisite throw, etc.) bubbles
 * unchanged so it is not masked by this translation.
 *
 * Exported so the error-translation behaviour can be exercised directly in
 * unit tests (point the loader at a non-existent module path); the handlers
 * call it with a fixed-path loader.
 *
 * @param loader the `() => import('../../modules/docker/<file>.js')` thunk.
 * @returns the imported module namespace.
 * @throws `ModulePrerequisiteFailed` when the module file is absent on disk.
 */
export async function importDockerModule<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw createError('ModulePrerequisiteFailed', {
        module: 'docker',
        message:
          `Module 'docker' could not be loaded: ${
            e instanceof Error ? e.message : String(e)
          }. ${DOCKER_MODULE_MISSING_HINT}`,
        errorHint: DOCKER_MODULE_MISSING_HINT,
      });
    }
    throw e;
  }
}

/**
 * Input to {@link dockerReservePort}.
 *
 * @property worktreePath the worktree to register; canonicalised by the
 *   library before becoming the registry key.
 * @property port host port to assign (`0..65535`); caller-supplied per the
 *   contract.
 * @property containerName container name to associate with the port.
 */
export interface DockerReservePortInput {
  worktreePath: string;
  port: number;
  containerName: string;
}

/**
 * Result the handler echoes back to the caller on success — the three input
 * fields confirming the reservation persisted, plus the F2 mutation indicator.
 *
 * @property mutated always `true`: the library `register` throws `PortInUse`
 *   on a conflict and otherwise persists the reservation, so a normal return
 *   always means durable state changed. Surfaced under the uniform F2
 *   `mutated` name alongside the other R7 write tools.
 */
export interface DockerReservePortResult {
  worktreePath: string;
  port: number;
  containerName: string;
  mutated: true;
}

/**
 * Reserve a host port for a worktree.
 *
 * Thin wrapper around the shipped `PortRegistry.register(worktreePath,
 * port, containerName)`. The handler constructs a `PortRegistry` against
 * the worktree's repository root (the caller's `worktreePath`) and calls
 * `register` with the three caller-supplied fields. No port mutation, no
 * scan, no free-port allocation — caller supplies the candidate port.
 *
 * @param input see {@link DockerReservePortInput}.
 * @returns `{ worktreePath, port, containerName, mutated: true }` confirming the
 *   reservation persisted.
 * @throws `PortInUse` propagated verbatim from the library when the port
 *   is already held by a different worktree (the registry's
 *   self-update path remains allowed and does not throw). Side effect:
 *   persists the registry through the module-state store.
 */
export async function dockerReservePort(
  input: DockerReservePortInput,
): Promise<DockerReservePortResult> {
  // Dynamic import of the docker library defers its load to first
  // call, so the server boots cleanly on a Docker-less host. The
  // registry write path enforces the prerequisite check downstream:
  // PortRegistry.register persists through the module-state store,
  // which routes through assertStateKeyAllowed → the module loader,
  // and that loader runs each module's manifest prerequisite. On a
  // Docker-less host the prereq fails with ModulePrerequisiteFailed
  // carrying the manifest's errorHint — exactly the failure surface
  // the spec pins.
  const { PortRegistry } = await importDockerModule(
    () => import('../../modules/docker/PortRegistry.js'),
  );
  const registry = new PortRegistry(input.worktreePath);
  registry.register(input.worktreePath, input.port, input.containerName);
  // register() either persisted the reservation or threw PortInUse; reaching
  // here means it persisted, so the F2 mutation indicator is always true.
  return {
    worktreePath: input.worktreePath,
    port: input.port,
    containerName: input.containerName,
    mutated: true,
  };
}

/**
 * Input to {@link dockerReleasePort}.
 *
 * @property worktreePath the worktree whose allocation is being released.
 */
export interface DockerReleasePortInput {
  worktreePath: string;
}

/**
 * Result echoed back to the caller on success.
 *
 * @property worktreePath the worktree the release targeted.
 * @property released `true` when the worktree had a live allocation that was
 *   removed; `false` when the call was a no-op because no entry existed.
 * @property mutated the F2 mutation indicator; equal to `released` — a removed
 *   allocation changed durable state, a no-op on an unregistered worktree did
 *   not. Surfaced under the uniform name so the orchestrator branches on the
 *   same field across every R7 write tool (`released` is kept for the
 *   release-specific reading).
 */
export interface DockerReleasePortResult {
  worktreePath: string;
  released: boolean;
  mutated: boolean;
}

/**
 * Release the allocation for a worktree.
 *
 * Thin wrapper around the shipped `PortRegistry.release(worktreePath)`.
 * Releasing an unregistered worktree is a silent no-op at the library
 * level; the handler preserves that contract — it does not invent a
 * different failure mode for the unregistered case.
 *
 * @param input see {@link DockerReleasePortInput}.
 * @returns `{ worktreePath, released, mutated }` where `released` (and the
 *   equal `mutated`) reflect whether the library actually removed an entry
 *   (`true`) or the call was a no-op on an unregistered worktree (`false`).
 */
export async function dockerReleasePort(
  input: DockerReleasePortInput,
): Promise<DockerReleasePortResult> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. release()'s persist call routes through the
  // module loader's allowlist gate, which runs the manifest prereq on
  // a Docker-less host (releasing an unregistered worktree is a no-op
  // and never persists, so its prereq check is similarly skipped).
  const { PortRegistry } = await importDockerModule(
    () => import('../../modules/docker/PortRegistry.js'),
  );
  const registry = new PortRegistry(input.worktreePath);
  const released = registry.release(input.worktreePath);
  // `released` is the durable-state-changed signal; mirror it onto the uniform
  // F2 `mutated` name so callers branch on one field across every R7 write tool.
  return {
    worktreePath: input.worktreePath,
    released,
    mutated: released,
  };
}

/**
 * Input to {@link dockerDiscoverPort}. Mirrors the library's
 * `DiscoverPortOptions` field-for-field; every field is optional and
 * layered discovery skips any layer whose inputs are absent.
 *
 * @property envVar name of an env var to read the port from (layer 1).
 * @property worktreePath worktree key for the registry lookup (layer 2);
 *   when supplied the handler constructs a `PortRegistry` against it.
 * @property containerPattern `docker ps --filter name=` pattern (layer 3).
 * @property fallbackPort static port used as the last resort (layer 4).
 */
export interface DockerDiscoverPortInput {
  envVar?: string;
  worktreePath?: string;
  containerPattern?: string;
  fallbackPort?: number;
}

/**
 * Discover the host port for a worktree's container.
 *
 * Thin wrapper around the shipped `discoverPort(options)`. The handler
 * constructs the `PortRegistry` from `worktreePath` (when supplied) and
 * forwards the rest of the inputs verbatim so the tool surface stays
 * declarative — the caller does not have to pre-instantiate a registry.
 *
 * @param input see {@link DockerDiscoverPortInput}.
 * @returns `{ port }` — the first valid port found across the four layers.
 * @throws `PortNotDiscovered` propagated verbatim from the library when
 *   every layer is absent or yields nothing.
 */
export async function dockerDiscoverPort(
  input: DockerDiscoverPortInput,
): Promise<{ port: number }> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. PortDiscovery's layer-3 spawnSync of `docker
  // ps` is what runs the real docker binary, so a Docker-less host
  // gets a layer-3 error (stdout empty / spawn ENOENT) that the
  // library translates into a fall-through to layer 4 or a
  // PortNotDiscovered. The registry layer 2 is the deliberate path.
  const { discoverPort } = await importDockerModule(
    () => import('../../modules/docker/PortDiscovery.js'),
  );
  const { PortRegistry } = await importDockerModule(
    () => import('../../modules/docker/PortRegistry.js'),
  );

  // Build the options bag in the shape the library expects. Only supply
  // a registry when worktreePath is provided — layer 2 silently skips
  // when its inputs are absent and the handler must not invent one.
  const options: Parameters<typeof discoverPort>[0] = {};
  if (typeof input.envVar === 'string' && input.envVar.length > 0) {
    options.envVar = input.envVar;
  }
  if (typeof input.worktreePath === 'string' && input.worktreePath.length > 0) {
    options.worktreePath = input.worktreePath;
    options.registry = new PortRegistry(input.worktreePath);
  }
  if (typeof input.containerPattern === 'string' && input.containerPattern.length > 0) {
    options.containerPattern = input.containerPattern;
  }
  if (typeof input.fallbackPort === 'number' && Number.isFinite(input.fallbackPort)) {
    options.fallbackPort = input.fallbackPort;
  }
  const port = await discoverPort(options);
  return { port };
}

/**
 * Input to {@link dockerCheckContainerHealth}.
 *
 * The contract recorded ambiguity in the spawn-brief between a
 * `{ containerName }` shape and the library's `waitForHealthy(port,
 * options)` signature. This handler resolves the ambiguity by adopting the
 * library's port-based shape verbatim: callers pass `port`, `path`,
 * `expectStatus`, and `timeoutSeconds`. The polling loop is the library's
 * — the handler does not re-implement it.
 *
 * @property port host port the service is bound to.
 * @property path localhost-relative request path to poll. Must be
 *   path-absolute (a single leading `/`, never a scheme-relative `//`) and
 *   free of control bytes, whitespace, `?`, and `#`; the boundary rejects
 *   anything else so the probe cannot be redirected off the localhost origin.
 * @property expectStatus the response status that signals healthy.
 * @property timeoutSeconds overall budget across all polls.
 */
export interface DockerCheckContainerHealthInput {
  port: number;
  path: string;
  expectStatus: number;
  timeoutSeconds: number;
}

/**
 * Result of {@link dockerCheckContainerHealth} on success.
 *
 * @property observedStatus the HTTP status code that signalled health — equal
 *   to the requested `expectStatus`, returned so the caller has the concrete
 *   observed value rather than a constant. (The unhealthy outcome is the
 *   thrown `TimeoutError`, not a field on this shape; success implies the
 *   expected status was observed within the budget.)
 */
export interface DockerCheckContainerHealthResult {
  observedStatus: number;
}

/**
 * Poll a container's HTTP surface until it responds with the expected
 * status, or until the timeout elapses.
 *
 * BLOCKS: this is a *waiter*, not a one-shot probe. Despite the `Check` name
 * (pinned on the wire), the call polls in a loop and does not resolve until
 * either the expected status is observed or `timeoutSeconds` elapses — so a
 * caller may block for up to `timeoutSeconds`. Size `timeoutSeconds`
 * accordingly; a one-shot yes/no is not what this tool provides.
 *
 * Thin wrapper around the shipped `waitForHealthy(port, options)`. The
 * handler forwards each input field as the library's named option; it
 * does not re-implement the per-poll bound, the inter-poll sleep, or the
 * timeout-error construction.
 *
 * The success/failure split is throw-on-failure by the library's contract:
 * the call resolves only when the expected status was observed and throws
 * `TimeoutError` otherwise. The result therefore carries the concrete
 * `observedStatus` (the status that confirmed health) rather than a vacuous
 * always-true boolean — a caller branches on the thrown error for the
 * unhealthy case, and reads `observedStatus` for the confirmed value.
 *
 * @param input see {@link DockerCheckContainerHealthInput}.
 * @returns `{ observedStatus }` — the status code that signalled health.
 * @throws `TimeoutError` propagated verbatim from the library when the
 *   budget is exhausted without a matching response.
 */
export async function dockerCheckContainerHealth(
  input: DockerCheckContainerHealthInput,
): Promise<DockerCheckContainerHealthResult> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. waitForHealthy itself uses the stdlib fetch
  // against `http://localhost:<port>`, so a Docker-less host produces
  // a connection error per poll until the timeout, surfaced as
  // TimeoutError from the library — no separate prereq is needed for
  // the health check tool.
  const { waitForHealthy } = await importDockerModule(
    () => import('../../modules/docker/ContainerHealth.js'),
  );
  // waitForHealthy resolves only when a response matched expectStatus, so the
  // status that confirmed health is exactly expectStatus; throw-on-failure
  // means there is no other resolved outcome to distinguish.
  await waitForHealthy(input.port, {
    path: input.path,
    expectStatus: input.expectStatus,
    timeoutSeconds: input.timeoutSeconds,
  });
  return { observedStatus: input.expectStatus };
}

/**
 * Input to {@link dockerContainerName}.
 *
 * @property worktreePath the worktree to derive a name for; both the
 *   basename and the canonicalised full path are used by the library.
 */
export interface DockerContainerNameInput {
  worktreePath: string;
}

/**
 * Derive the deterministic Docker container name for a worktree.
 *
 * Thin wrapper around the shipped `nameForWorktree(worktreePath)`. The
 * handler does not pre-process the path — the library canonicalises
 * internally so two spellings of the same worktree collapse to the same
 * name. Pure function, no side effects, no subprocess.
 *
 * @param input see {@link DockerContainerNameInput}.
 * @returns `{ containerName }` — the deterministic `<sanitised-core>-<4-hex>`
 *   string the library produces.
 */
export async function dockerContainerName(
  input: DockerContainerNameInput,
): Promise<{ containerName: string }> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. nameForWorktree is a pure function (no
  // subprocess); it is shipped behind the docker module so the dynamic
  // import keeps the load shape uniform across all five handlers.
  const { nameForWorktree } = await importDockerModule(
    () => import('../../modules/docker/ContainerNaming.js'),
  );
  return { containerName: nameForWorktree(input.worktreePath) };
}

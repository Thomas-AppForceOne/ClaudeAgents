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
 */

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
 * fields confirming the reservation persisted.
 */
export interface DockerReservePortResult {
  worktreePath: string;
  port: number;
  containerName: string;
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
 * @returns `{ worktreePath, port, containerName }` confirming the
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
  const { PortRegistry } = await import('../../modules/docker/PortRegistry.js');
  const registry = new PortRegistry(input.worktreePath);
  registry.register(input.worktreePath, input.port, input.containerName);
  return {
    worktreePath: input.worktreePath,
    port: input.port,
    containerName: input.containerName,
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
 */
export interface DockerReleasePortResult {
  worktreePath: string;
  released: boolean;
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
 * @returns `{ worktreePath, released }` where `released` reflects whether the
 *   library actually removed an entry (`true`) or the call was a no-op on an
 *   unregistered worktree (`false`).
 */
export async function dockerReleasePort(
  input: DockerReleasePortInput,
): Promise<DockerReleasePortResult> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. release()'s persist call routes through the
  // module loader's allowlist gate, which runs the manifest prereq on
  // a Docker-less host (releasing an unregistered worktree is a no-op
  // and never persists, so its prereq check is similarly skipped).
  const { PortRegistry } = await import('../../modules/docker/PortRegistry.js');
  const registry = new PortRegistry(input.worktreePath);
  const released = registry.release(input.worktreePath);
  return {
    worktreePath: input.worktreePath,
    released,
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
  const { discoverPort } = await import('../../modules/docker/PortDiscovery.js');
  const { PortRegistry } = await import('../../modules/docker/PortRegistry.js');

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
 * Poll a container's HTTP surface until it responds with the expected
 * status, or until the timeout elapses.
 *
 * Thin wrapper around the shipped `waitForHealthy(port, options)`. The
 * handler forwards each input field as the library's named option; it
 * does not re-implement the per-poll bound, the inter-poll sleep, or the
 * timeout-error construction.
 *
 * @param input see {@link DockerCheckContainerHealthInput}.
 * @returns `{ healthy: true }` when the library returns `true`.
 * @throws `TimeoutError` propagated verbatim from the library when the
 *   budget is exhausted without a matching response.
 */
export async function dockerCheckContainerHealth(
  input: DockerCheckContainerHealthInput,
): Promise<{ healthy: true }> {
  // Dynamic import of the docker library — same boot-without-Docker
  // invariant as above. waitForHealthy itself uses the stdlib fetch
  // against `http://localhost:<port>`, so a Docker-less host produces
  // a connection error per poll until the timeout, surfaced as
  // TimeoutError from the library — no separate prereq is needed for
  // the health check tool.
  const { waitForHealthy } = await import('../../modules/docker/ContainerHealth.js');
  await waitForHealthy(input.port, {
    path: input.path,
    expectStatus: input.expectStatus,
    timeoutSeconds: input.timeoutSeconds,
  });
  return { healthy: true };
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
  const { nameForWorktree } = await import('../../modules/docker/ContainerNaming.js');
  return { containerName: nameForWorktree(input.worktreePath) };
}

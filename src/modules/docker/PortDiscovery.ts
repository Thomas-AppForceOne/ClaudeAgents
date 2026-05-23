/**
 * PortDiscovery — resolve the host port a worktree's container is reachable on,
 * trying ordered layers from most authoritative to most heuristic.
 *
 * `discoverPort` consults, in strict order: (1) an explicit env var, (2) the
 * persistent {@link PortRegistry} keyed by worktree, (3) a live `docker ps`
 * probe by container-name pattern, and (4) a static fallback port. The first
 * layer that yields a valid port wins; if every layer is absent or fails, the
 * function throws `PortNotDiscovered`. The ordering is the contract: an
 * operator's explicit env override always beats discovery, and the registry
 * (which records a deliberate allocation) beats a `docker ps` guess.
 *
 * A malformed-but-present signal does not skip silently to a worse layer
 * without explanation: a bad env var value is logged at warn level before
 * falling through, so an operator typo is visible rather than mysteriously
 * ignored.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createError } from '../../config-server/errors.js';
import { getLogger, type Logger } from '../../config-server/logging/logger.js';
import { PortRegistry } from './PortRegistry.js';

/** Subset of `spawnSync`'s return shape used by the docker-ps probe. */
export interface PortProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable runner for the `docker ps` probe; mirrors `spawnSync`. Tests stub it. */
export type DockerPsRunner = (file: string, args: readonly string[]) => PortProbeResult;

// Real runner: spawn `docker ps` synchronously, capturing stdout/stderr as
// UTF-8 strings (empty string when a stream is absent) so the probe parser has
// a uniform shape to work with.
const defaultDockerPs: DockerPsRunner = (file, args) => {
  const r: SpawnSyncReturns<Buffer> = spawnSync(file, [...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
};

/**
 * Inputs to {@link discoverPort}. Every field is optional; a layer is simply
 * skipped when its inputs are absent.
 *
 * @property envVar name of an env var to read the port from (layer 1).
 * @property worktreePath worktree key for the registry lookup (layer 2);
 *   required alongside `registry` for that layer to run.
 * @property registry persistent allocation store consulted in layer 2.
 * @property containerPattern `docker ps --filter name=` pattern for layer 3.
 * @property fallbackPort static port used as the last resort (layer 4).
 * @property dockerPsRunner override for the `docker ps` runner; defaults to a
 *   real `spawnSync`. Test injection seam.
 * @property env environment to read `envVar` from; defaults to `process.env`.
 * @property logger structured logger for fall-through warnings; defaults to the
 *   shared logger.
 */
export interface DiscoverPortOptions {

  envVar?: string;

  worktreePath?: string;

  registry?: PortRegistry;

  containerPattern?: string;

  fallbackPort?: number;

  dockerPsRunner?: DockerPsRunner;

  env?: NodeJS.ProcessEnv;

  logger?: Logger;
}

/**
 * Resolve a host port by trying the four layers in order (see the module block).
 *
 * @param options the layer inputs; see {@link DiscoverPortOptions}.
 * @returns the first valid port found (0..65535).
 * @throws `PortNotDiscovered` when every layer is absent or yields nothing.
 *
 * Async only for forward compatibility — the body is currently synchronous, so
 * callers should still `await` it. Side effect: logs a warning when a present
 * env var holds an invalid port and the function falls through to a later layer.
 */
export async function discoverPort(options: DiscoverPortOptions): Promise<number> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? getLogger();

  // Layer 1 — explicit env var. An operator override is most authoritative, so
  // it is tried first. A present-but-invalid value warns and falls through
  // (rather than failing) so a typo does not block discovery entirely.
  if (typeof options.envVar === 'string' && options.envVar.length > 0) {
    const raw = env[options.envVar];
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 65535) {
        return parsed;
      }
      logger.warn(
        `PortDiscovery: env var '${options.envVar}' value '${raw}' is not a valid port (0..65535); falling through.`,
        { tool: 'PortDiscovery' },
      );
    } else {
      logger.warn(
        `PortDiscovery: env var '${options.envVar}' is not set; falling through to next layer.`,
        { tool: 'PortDiscovery' },
      );
    }
  }

  // Layer 2 — registry. A recorded allocation reflects a deliberate prior
  // assignment, so it beats the live `docker ps` guess below.
  if (options.registry && typeof options.worktreePath === 'string' && options.worktreePath.length > 0) {
    const entry = options.registry.lookup(options.worktreePath);
    if (entry !== null) {
      return entry.port;
    }
  }

  // Layer 3 — live `docker ps` probe by container-name pattern.
  if (typeof options.containerPattern === 'string' && options.containerPattern.length > 0) {
    const port = probeDockerPs(options.containerPattern, options.dockerPsRunner ?? defaultDockerPs);
    if (port !== null) return port;
  }

  // Layer 4 — static fallback, the last resort before failing.
  if (typeof options.fallbackPort === 'number' && Number.isFinite(options.fallbackPort)) {
    return options.fallbackPort;
  }

  throw createError('PortNotDiscovered', {
    message:
      'PortDiscovery exhausted every layer (env var, registry, docker ps, fallback) without ' +
      'producing a port. Set a fallbackPort in the docker module config or set the named env var.',
  });
}

// Probe `docker ps` for the host port published by a container matching
// `pattern`. Returns the first valid port found, or null when the command
// errors, exits non-zero, or no line matches. All failure modes collapse to
// null so the caller treats "no port from docker" uniformly and moves on.
function probeDockerPs(pattern: string, runner: DockerPsRunner): number | null {
  let r: PortProbeResult;
  try {
    r = runner('docker', [
      'ps',
      '--filter',
      `name=${pattern}`,
      '--format',
      '{{.Ports}}',
    ]);
  } catch {
    return null;
  }
  if (r.status !== 0) return null;
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {

    // Match docker's `<host-addr>:<host-port>-><container-port>` mapping syntax
    // and capture the HOST port. The host-addr alternation covers IPv4
    // (1.2.3.4), the IPv6-any shorthand (::), and bracketed IPv6 ([::1]); the
    // trailing `->` anchors on the publish arrow so a bare container port is
    // not mistaken for a host port.
    const match = /(?:\d{1,3}(?:\.\d{1,3}){3}|::|\[[^\]]*\]):(\d+)->/.exec(line);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!Number.isNaN(port) && port >= 0 && port <= 65535) return port;
    }
  }
  return null;
}

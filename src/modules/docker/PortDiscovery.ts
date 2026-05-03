/**
 * PortDiscovery — four-layer fallback for "what host port should I use?"
 *
 * Layers, evaluated in order, returning the first hit:
 *
 *   1. **Env-var layer.** `options.envVar` is the *name* of an environment
 *      variable (a string key into `process.env`), NOT the port value.
 *      Reads `process.env[options.envVar]`. Treats unset, non-numeric, or
 *      out-of-range (`< 0` or `> 65535`) values as a fall-through and
 *      logs a warning via the project logger.
 *
 *   2. **PortRegistry lookup.** Returns the port previously registered
 *      for the current worktree (`options.worktreePath`).
 *
 *   3. **`docker ps` parsing.** Runs
 *      `docker ps --filter name=<containerPattern> --format ...` and
 *      parses the host port from the output's `PORTS` column.
 *
 *   4. **Fallback.** `options.fallbackPort`, when provided.
 *
 * If no layer yields a port, throws `PortNotDiscovered` via the central
 * error factory.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createError } from '../../config-server/errors.js';
import { getLogger, type Logger } from '../../config-server/logging/logger.js';
import { PortRegistry } from './PortRegistry.js';

/** Mirror of `spawnSync`'s subset that PortDiscovery uses. */
export interface PortProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type DockerPsRunner = (file: string, args: readonly string[]) => PortProbeResult;

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

export interface DiscoverPortOptions {
  /** **Name** of an env var. Read via `process.env[envVar]`. */
  envVar?: string;
  /** Worktree path used for the PortRegistry lookup. */
  worktreePath?: string;
  /** PortRegistry instance for layer 2. Optional; layer skipped when omitted. */
  registry?: PortRegistry;
  /** Container-name match pattern for `docker ps --filter name=<pattern>`. */
  containerPattern?: string;
  /** Fallback port (layer 4). */
  fallbackPort?: number;
  /** Test injection point for `docker ps`. */
  dockerPsRunner?: DockerPsRunner;
  /** Override `process.env`. Tests pass a hermetic record. */
  env?: NodeJS.ProcessEnv;
  /** Logger override. Defaults to `getLogger()`. */
  logger?: Logger;
}

/**
 * Walk the four-layer fallback chain. See the file-level doc comment for
 * the layer ordering and per-layer rules.
 */
export async function discoverPort(options: DiscoverPortOptions): Promise<number> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? getLogger();

  // Layer 1: env-var layer. options.envVar is a NAME, not a value.
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

  // Layer 2: PortRegistry lookup for the current worktree.
  if (options.registry && typeof options.worktreePath === 'string' && options.worktreePath.length > 0) {
    const entry = options.registry.lookup(options.worktreePath);
    if (entry !== null) {
      return entry.port;
    }
  }

  // Layer 3: `docker ps --filter name=<containerPattern>` parsing.
  if (typeof options.containerPattern === 'string' && options.containerPattern.length > 0) {
    const port = probeDockerPs(options.containerPattern, options.dockerPsRunner ?? defaultDockerPs);
    if (port !== null) return port;
  }

  // Layer 4: fallbackPort.
  if (typeof options.fallbackPort === 'number' && Number.isFinite(options.fallbackPort)) {
    return options.fallbackPort;
  }

  throw createError('PortNotDiscovered', {
    message:
      'PortDiscovery exhausted every layer (env var, registry, docker ps, fallback) without ' +
      'producing a port. Set a fallbackPort in the docker module config or set the named env var.',
  });
}

/**
 * Run `docker ps --filter name=<pattern> --format {{.Ports}}` and return
 * the first host port found. Returns `null` when no container matches
 * or no host port can be parsed.
 */
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
    // `docker ps --format {{.Ports}}` rows look like:
    //   0.0.0.0:8080->80/tcp, :::8080->80/tcp
    // Look for the first `<host>:<port>->` pattern.
    const match = /(?:\d{1,3}(?:\.\d{1,3}){3}|::|\[[^\]]*\]):(\d+)->/.exec(line);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!Number.isNaN(port) && port >= 0 && port <= 65535) return port;
    }
  }
  return null;
}

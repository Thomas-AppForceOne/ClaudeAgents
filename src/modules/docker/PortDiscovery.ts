

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createError } from '../../config-server/errors.js';
import { getLogger, type Logger } from '../../config-server/logging/logger.js';
import { PortRegistry } from './PortRegistry.js';

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

  envVar?: string;

  worktreePath?: string;

  registry?: PortRegistry;

  containerPattern?: string;

  fallbackPort?: number;

  dockerPsRunner?: DockerPsRunner;

  env?: NodeJS.ProcessEnv;

  logger?: Logger;
}

export async function discoverPort(options: DiscoverPortOptions): Promise<number> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? getLogger();

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

  if (options.registry && typeof options.worktreePath === 'string' && options.worktreePath.length > 0) {
    const entry = options.registry.lookup(options.worktreePath);
    if (entry !== null) {
      return entry.port;
    }
  }

  if (typeof options.containerPattern === 'string' && options.containerPattern.length > 0) {
    const port = probeDockerPs(options.containerPattern, options.dockerPsRunner ?? defaultDockerPs);
    if (port !== null) return port;
  }

  if (typeof options.fallbackPort === 'number' && Number.isFinite(options.fallbackPort)) {
    return options.fallbackPort;
  }

  throw createError('PortNotDiscovered', {
    message:
      'PortDiscovery exhausted every layer (env var, registry, docker ps, fallback) without ' +
      'producing a port. Set a fallbackPort in the docker module config or set the named env var.',
  });
}

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

    const match = /(?:\d{1,3}(?:\.\d{1,3}){3}|::|\[[^\]]*\]):(\d+)->/.exec(line);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!Number.isNaN(port) && port >= 0 && port <= 65535) return port;
    }
  }
  return null;
}

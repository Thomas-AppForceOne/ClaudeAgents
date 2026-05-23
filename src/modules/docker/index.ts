

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createError } from '../../config-server/errors.js';

interface PrereqEntry {
  command: string;
  errorHint: string;
}

interface DockerManifestShape {
  prerequisites?: PrereqEntry[];
}

function loadManifest(): DockerManifestShape {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(here, 'manifest.json');
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as DockerManifestShape;
}

export function _runPrerequisiteCheck(
  exec: typeof execFileSync = execFileSync,
  manifest: DockerManifestShape = loadManifest(),
): void {
  const prereqs = manifest.prerequisites ?? [];
  for (const prereq of prereqs) {
    const tokens = prereq.command.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      throw createError('ModulePrerequisiteFailed', {
        message:
          `Docker module prerequisite command is empty after whitespace-split. ${prereq.errorHint}`,
        errorHint: prereq.errorHint,
      });
    }
    const [file, ...args] = tokens;
    try {
      exec(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) {
      throw createError('ModulePrerequisiteFailed', {
        message:
          `Docker module prerequisite '${prereq.command}' failed: ${
            e instanceof Error ? e.message : String(e)
          }. ${prereq.errorHint}`,
        errorHint: prereq.errorHint,
      });
    }
  }
}

_runPrerequisiteCheck();

export { PortRegistry } from './PortRegistry.js';
export type { PortRegistryEntry, PortRegistryFile } from './PortRegistry.js';

import { nameForWorktree } from './ContainerNaming.js';
export type { NameForWorktreeOptions } from './ContainerNaming.js';

export const ContainerNaming = { nameForWorktree } as const;

import { isPortFree } from './PortValidator.js';
export type { IsPortFreeOptions, PortProbeResult, PortProbeRunner } from './PortValidator.js';

export const PortValidator = { isPortFree } as const;

import { discoverPort } from './PortDiscovery.js';
export type { DiscoverPortOptions, DockerPsRunner } from './PortDiscovery.js';

export const PortDiscovery = { discoverPort } as const;

import { waitForHealthy } from './ContainerHealth.js';
export type { WaitForHealthyOptions } from './ContainerHealth.js';

export const ContainerHealth = { waitForHealthy } as const;

export { nameForWorktree, isPortFree, discoverPort, waitForHealthy };

/**
 * Docker module barrel.
 *
 * On evaluation:
 *
 *   1. Runs the manifest's prerequisite check (`docker --version`) via
 *      `child_process.execFileSync` — whitespace-split, no shell expansion.
 *      A non-zero exit (or any spawn error) throws via the central error
 *      factory; the thrown error message includes the manifest's
 *      `errorHint` so an agent catching it gets actionable text.
 *   2. Re-exports the five module utilities listed in the manifest's
 *      `exports` array: `PortRegistry`, `ContainerNaming`, `PortValidator`,
 *      `PortDiscovery`, `ContainerHealth`.
 *
 * The prerequisite runner is exposed as `_runPrerequisiteCheck` so tests
 * can mock `execFileSync` and exercise the failure path without an
 * environment dependency on the real `docker` binary.
 */

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

/**
 * Read the docker manifest at module-evaluation time. The path is
 * resolved relative to this source file so the barrel works whether the
 * package is consumed from `src/` (tests) or `dist/` (production).
 */
function loadManifest(): DockerManifestShape {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(here, 'manifest.json');
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as DockerManifestShape;
}

/**
 * Run every prerequisite command from the docker manifest. Each command
 * is whitespace-split (no shell expansion) and dispatched via
 * `execFileSync`. Failure throws via `createError('ModulePrerequisiteFailed', ...)`
 * with the manifest's `errorHint` woven into the message.
 */
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

// Run the prerequisite check at module-evaluation time. The barrel must
// fail-fast when Docker is missing so an agent importing the module
// receives a structured error rather than a confusing utility-call
// failure later in the run.
_runPrerequisiteCheck();

// The manifest's `exports` array names — these are the canonical
// public-API surface. `ContainerNaming` and `PortValidator` are
// re-exported under the manifest names as namespace objects bundling
// their helpers; `PortRegistry`, `PortDiscovery`, and `ContainerHealth`
// are named symbols (class / function).

export { PortRegistry } from './PortRegistry.js';
export type { PortRegistryEntry, PortRegistryFile } from './PortRegistry.js';

import { nameForWorktree } from './ContainerNaming.js';
export type { NameForWorktreeOptions } from './ContainerNaming.js';
/** Manifest-name surface: ContainerNaming bundles `nameForWorktree`. */
export const ContainerNaming = { nameForWorktree } as const;

import { isPortFree } from './PortValidator.js';
export type { IsPortFreeOptions, PortProbeResult, PortProbeRunner } from './PortValidator.js';
/** Manifest-name surface: PortValidator bundles `isPortFree`. */
export const PortValidator = { isPortFree } as const;

import { discoverPort } from './PortDiscovery.js';
export type { DiscoverPortOptions, DockerPsRunner } from './PortDiscovery.js';
/** Manifest-name surface: PortDiscovery bundles `discoverPort`. */
export const PortDiscovery = { discoverPort } as const;

import { waitForHealthy } from './ContainerHealth.js';
export type { WaitForHealthyOptions } from './ContainerHealth.js';
/** Manifest-name surface: ContainerHealth bundles `waitForHealthy`. */
export const ContainerHealth = { waitForHealthy } as const;

// Also re-export the underlying helpers under their function-level
// names for callers that prefer them.
export { nameForWorktree, isPortFree, discoverPort, waitForHealthy };

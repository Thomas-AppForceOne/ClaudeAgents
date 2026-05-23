/**
 * Docker module — public entry point and prerequisite gate.
 *
 * This barrel exposes the docker module's capabilities (container naming, port
 * validation/discovery, health-checking, the port registry) as namespaced
 * objects plus their free-function forms, and re-exports their types.
 *
 * It also runs a side-effecting prerequisite check *at import time*: importing
 * this module verifies that the host satisfies the commands listed in the
 * docker module's `manifest.json` (e.g. that the `docker` CLI is present). The
 * check throws `ModulePrerequisiteFailed` on the first unmet prerequisite, so a
 * module whose host cannot support it fails loudly at load rather than midway
 * through a run. The named-export `_runPrerequisiteCheck` is the same routine
 * with injectable seams so tests can exercise it without a real `docker`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createError } from '../../config-server/errors.js';

// Shape of one manifest prerequisite: the command to run and the operator-facing
// hint to surface if it fails.
interface PrereqEntry {
  command: string;
  errorHint: string;
}

// The subset of the docker manifest this module reads.
interface DockerManifestShape {
  prerequisites?: PrereqEntry[];
}

// Read and parse the module's manifest.json, resolved relative to this file's
// own location (not cwd) so it is found regardless of where the process runs.
function loadManifest(): DockerManifestShape {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(here, 'manifest.json');
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as DockerManifestShape;
}

/**
 * Run every manifest-declared prerequisite command, throwing on the first
 * failure. Exported (with the `_` prefix marking it as test/internal surface)
 * so its seams can be injected.
 *
 * @param exec command runner; defaults to `execFileSync`. Test seam.
 * @param manifest the manifest to read prerequisites from; defaults to the
 *   module's own `manifest.json`. Test seam.
 * @throws `ModulePrerequisiteFailed` when a command is empty after tokenisation,
 *   or when running it throws (e.g. the binary is missing or exits non-zero);
 *   the error carries the manifest's `errorHint` to guide the operator.
 *
 * Commands are split on whitespace into `argv` and run without a shell, so a
 * prerequisite string cannot inject shell syntax.
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

// Import-time gate: fail fast if the host cannot support the docker module.
_runPrerequisiteCheck();

export { PortRegistry } from './PortRegistry.js';
export type { PortRegistryEntry, PortRegistryFile } from './PortRegistry.js';

import { nameForWorktree } from './ContainerNaming.js';
export type { NameForWorktreeOptions } from './ContainerNaming.js';

// Capability namespaces: each groups its function(s) under a stable object so
// callers can write `ContainerNaming.nameForWorktree(...)`. The same functions
// are also re-exported standalone at the bottom for direct import.
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

// Standalone re-exports of the same functions, for callers that prefer a flat
// import over the namespace objects above.
export { nameForWorktree, isPortFree, discoverPort, waitForHealthy };

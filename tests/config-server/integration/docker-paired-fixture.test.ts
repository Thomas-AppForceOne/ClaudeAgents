/**
 * M2 — docker-paired fixture integration test (AC10 + AC11 + AC12).
 *
 * Runs the config server against
 * `tests/fixtures/stacks/docker-paired/` with a hermetic
 * `modulesRoot` (a scratch directory containing a docker module
 * manifest with no prerequisites — so the test does not require Docker
 * on the running machine) and asserts:
 *
 *   - `getStack("docker")` returns the resolved data including
 *     `pairsWith: "docker"` from the project-tier file.
 *   - `validateAll()` produces zero pairs-with errors AND zero schema
 *     errors against the fixture.
 *   - `getResolvedConfig().modules.docker` reflects the four-field YAML
 *     config from `.claude/gan/modules/docker.yaml`.
 *
 * The fixture is the only docker-paired stack file in the repo (no
 * shipped `stacks/docker.md` at the repo root).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { getStack } from '../../../src/config-server/tools/reads.js';
import { composeResolvedConfig } from '../../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'docker-paired');

describe('docker-paired fixture integration', () => {
  let scratchModulesRoot: string;

  beforeEach(() => {
    clearResolvedConfigCache();
    _resetModuleRegistrationCacheForTests();
    // Stage a hermetic docker module manifest with NO prerequisites so
    // the test does not require Docker on the running machine.
    scratchModulesRoot = mkdtempSync(path.join(os.tmpdir(), 'm2-docker-paired-modules-'));
    const dockerStaging = path.join(scratchModulesRoot, 'docker');
    mkdirSync(dockerStaging, { recursive: true });
    writeFileSync(
      path.join(dockerStaging, 'manifest.json'),
      JSON.stringify(
        {
          name: 'docker',
          schemaVersion: 1,
          pairsWith: 'docker',
          description: 'Container and port management for git worktree workflows.',
          exports: [
            'PortRegistry',
            'PortDiscovery',
            'ContainerHealth',
            'PortValidator',
            'ContainerNaming',
          ],
          stateKeys: ['port-registry'],
          configKey: 'docker',
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => {
    rmSync(scratchModulesRoot, { recursive: true, force: true });
    clearResolvedConfigCache();
    _resetModuleRegistrationCacheForTests();
  });

  it('the fixture stack file exists and is the only docker-paired stack file', () => {
    const stackPath = path.join(fixtureRoot, '.claude', 'gan', 'stacks', 'docker.md');
    expect(existsSync(stackPath)).toBe(true);
    // No shipped repo-tier docker.md.
    expect(existsSync(path.join(repoRoot, 'stacks', 'docker.md'))).toBe(false);
  });

  it('getStack("docker") returns resolved data including pairsWith: docker', () => {
    const result = getStack({ projectRoot: fixtureRoot, name: 'docker' });
    expect(result.sourceTier).toBe('project');
    const data = result.data as Record<string, unknown>;
    expect(data.pairsWith).toBe('docker');
    expect(data.name).toBe('docker');
  });

  it('validateAll produces zero pairs-with and zero schema errors', () => {
    const result = validateAll(
      { projectRoot: fixtureRoot },
      { modulesRoot: scratchModulesRoot },
    );
    const pairsWithIssues = result.issues.filter(
      (i) => typeof i.message === 'string' && i.message.includes('pairs-with'),
    );
    expect(pairsWithIssues).toEqual([]);
    const schemaIssues = result.issues.filter(
      (i) => i.code === 'ValidationFailed' || i.code === 'SchemaMismatch',
    );
    expect(schemaIssues).toEqual([]);
  });

  it('getResolvedConfig.modules.docker reflects fixture YAML', async () => {
    const r = await composeResolvedConfig(fixtureRoot, {
      apiVersion: '0.0.0-test',
      modulesRoot: scratchModulesRoot,
    });
    const dockerEntry = r.modules.docker;
    expect(dockerEntry).toBeDefined();
    expect(dockerEntry.schemaVersion).toBe(1);
    expect(dockerEntry.containerPattern).toBe('myapp-*');
    expect(dockerEntry.fallbackPort).toBe(8080);
    expect(dockerEntry.healthCheck).toEqual({
      path: '/health',
      expectStatus: 200,
      timeoutSeconds: 30,
    });
  });
});

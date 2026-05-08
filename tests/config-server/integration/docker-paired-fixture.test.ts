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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { getModuleState, getStack } from '../../../src/config-server/tools/reads.js';
import { setModuleState } from '../../../src/config-server/tools/writes.js';
import { composeResolvedConfig } from '../../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'docker-paired');

describe('docker-paired fixture integration', () => {
  let scratchModulesRoot: string;
  let scratchPkgRoot: string;
  let savedPkgOverride: string | undefined;
  const scratchProjects: string[] = [];

  beforeEach(() => {
    clearResolvedConfigCache();
    _resetModuleRegistrationCacheForTests();
    // Stage a hermetic docker module manifest with NO prerequisites so
    // the test does not require Docker on the running machine.
    scratchModulesRoot = mkdtempSync(path.join(os.tmpdir(), 'm2-docker-paired-modules-'));
    const dockerStaging = path.join(scratchModulesRoot, 'docker');
    mkdirSync(dockerStaging, { recursive: true });
    const dockerManifest = {
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
    };
    writeFileSync(
      path.join(dockerStaging, 'manifest.json'),
      JSON.stringify(dockerManifest, null, 2),
    );

    // Stage a fake "package root" pointing at the same docker manifest
    // so `setModuleState`/`getModuleState` (which resolve modules via
    // `defaultModulesRoot()`) can find the `port-registry` state key
    // in the manifest's `stateKeys` allowlist.
    scratchPkgRoot = mkdtempSync(path.join(os.tmpdir(), 'm2-docker-paired-pkgroot-'));
    const realPkg = path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
      'package.json',
    );
    writeFileSync(path.join(scratchPkgRoot, 'package.json'), readFileSync(realPkg, 'utf8'));
    const pkgDockerDir = path.join(scratchPkgRoot, 'src', 'modules', 'docker');
    mkdirSync(pkgDockerDir, { recursive: true });
    writeFileSync(
      path.join(pkgDockerDir, 'manifest.json'),
      JSON.stringify(dockerManifest, null, 2),
    );
    savedPkgOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = scratchPkgRoot;
    _resetPackageRootCacheForTests();
  });
  afterEach(() => {
    rmSync(scratchModulesRoot, { recursive: true, force: true });
    rmSync(scratchPkgRoot, { recursive: true, force: true });
    if (savedPkgOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedPkgOverride;
    }
    while (scratchProjects.length > 0) {
      const dir = scratchProjects.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
    clearResolvedConfigCache();
    _resetModuleRegistrationCacheForTests();
    _resetPackageRootCacheForTests();
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

  it('getResolvedConfig.modules.docker reflects fixture YAML config AND getModuleState returns persisted state when both exist', async () => {
    // Stage a writable copy of the fixture so the test can persist
    // module state without mutating the shared `tests/fixtures/...`
    // tree. The original fixture must be byte-unchanged after the
    // test run.
    const scratchProj = mkdtempSync(path.join(os.tmpdir(), 'gan-test-'));
    scratchProjects.push(scratchProj);
    cpSync(fixtureRoot, scratchProj, { recursive: true });

    const blob = {
      version: 1,
      entries: { '/some/wt': { port: 9999, containerName: 'demo' } },
    };
    const writeResult = setModuleState({
      projectRoot: scratchProj,
      name: 'docker',
      key: 'port-registry',
      state: blob,
    });
    expect(writeResult.mutated).toBe(true);

    // Both the YAML config (copied from the fixture) and the
    // persisted port-registry.json (just written) must coexist.
    expect(existsSync(path.join(scratchProj, '.claude', 'gan', 'modules', 'docker.yaml'))).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(scratchProj, '.gan-state', 'modules', 'docker', 'port-registry.json'),
      ),
    ).toBe(true);

    const r = await composeResolvedConfig(scratchProj, {
      apiVersion: '0.0.0-test',
      modulesRoot: scratchModulesRoot,
    });
    expect(r.modules.docker.containerPattern).toBe('myapp-*');
    expect(r.modules.docker.fallbackPort).toBe(8080);
    expect(r.modules.docker.healthCheck).toEqual({
      path: '/health',
      expectStatus: 200,
      timeoutSeconds: 30,
    });
    expect(typeof r.modules.docker.manifestPath).toBe('string');
    expect((r.modules.docker.manifestPath as string).length).toBeGreaterThan(0);

    const record = getModuleState({
      projectRoot: scratchProj,
      name: 'docker',
      key: 'port-registry',
    });
    expect(record).not.toBeNull();
    expect(record!.state).toEqual(blob);
  });
});

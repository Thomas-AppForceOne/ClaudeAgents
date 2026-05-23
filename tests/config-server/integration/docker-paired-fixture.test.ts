

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
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'docker-paired');

describe('docker-paired fixture integration', () => {
  let scratchModulesRoot: string;
  let scratchPkgRoot: string;
  let savedPkgOverride: string | undefined;
  let store: ModuleStateStoreScope;
  const scratchProjects: string[] = [];

  beforeEach(() => {
    clearResolvedConfigCache();
    _resetModuleRegistrationCacheForTests();
    store = useTempModuleStateStore();

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
    store.restore();
    rmSync(store.storeRoot, { recursive: true, force: true });
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
    const result = validateAll({ projectRoot: fixtureRoot }, { modulesRoot: scratchModulesRoot });
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

    const scratchProj = mkdtempSync(path.join(os.tmpdir(), 'gan-test-'));
    scratchProjects.push(scratchProj);
    cpSync(fixtureRoot, scratchProj, { recursive: true });

    initGitRepo(scratchProj);

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

    expect(existsSync(path.join(scratchProj, '.claude', 'gan', 'modules', 'docker.yaml'))).toBe(
      true,
    );

    expect(existsSync(store.statePath(scratchProj, 'docker', 'port-registry'))).toBe(true);

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

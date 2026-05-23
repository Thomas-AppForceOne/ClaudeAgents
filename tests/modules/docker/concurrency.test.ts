

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PortRegistry } from '../../../src/modules/docker/PortRegistry.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm2-conc-modroot-'));
  writeFileSync(
    path.join(root, 'package.json'),
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const dir = path.join(root, 'src', 'modules', 'docker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'docker',
        schemaVersion: 1,
        description: 'Container and port management for git worktree workflows.',
        exports: ['PortRegistry'],
        stateKeys: ['port-registry'],
      },
      null,
      2,
    ),
  );
  return root;
}

describe('PortRegistry concurrency', () => {
  let scratch: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-concurrency-'));

    initGitRepo(scratch);
    store = useTempModuleStateStore();
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    stagedRoot = stageDockerModuleRoot();
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    store.restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(stagedRoot, { recursive: true, force: true });
    rmSync(store.storeRoot, { recursive: true, force: true });
    if (savedOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedOverride;
    }
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  it('two clients writing distinct worktrees both land on disk', async () => {
    const regA = new PortRegistry(scratch);
    const regB = new PortRegistry(scratch);

    const wtA = path.join(scratch, 'wt-a');
    const wtB = path.join(scratch, 'wt-b');
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });

    const taskA = (async () => {
      await Promise.resolve();
      regA.register(wtA, 8001, 'app-a');
    })();
    const taskB = (async () => {
      await Promise.resolve();
      regB.register(wtB, 8002, 'app-b');
    })();
    await Promise.all([taskA, taskB]);

    const reg = new PortRegistry(scratch);
    const all = reg.getAll();
    expect(all).toHaveLength(2);
    const ports = all.map((e) => e.port).sort();
    expect(ports).toEqual([8001, 8002]);
  });

  it('refuses duplicate-port registration with a structured factory error', () => {
    const reg = new PortRegistry(scratch);
    const wtA = path.join(scratch, 'wt-a');
    const wtB = path.join(scratch, 'wt-b');
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    reg.register(wtA, 8080, 'app-a');
    let caught: unknown = null;
    try {
      reg.register(wtB, 8080, 'app-b');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('PortInUse');
  });
});

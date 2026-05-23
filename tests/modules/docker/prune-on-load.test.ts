

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PortRegistry } from '../../../src/modules/docker/PortRegistry.js';
import {
  _resetModuleRegistrationCacheForTests,
  moduleStatePath,
} from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'f8-prune-modroot-'));
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

describe('F8 prune-on-load frees absent-worktree ports', () => {
  let scratch: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'f8-prune-'));
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

  it('prunes only the absent-worktree entry, frees its port, and leaves the live entry untouched (injected probe)', () => {
    const liveWt = path.join(scratch, 'live-worktree');
    const goneWt = path.join(scratch, 'gone-worktree');
    mkdirSync(liveWt, { recursive: true });
    mkdirSync(goneWt, { recursive: true });

    const seed = new PortRegistry(scratch);
    seed.register(liveWt, 8080, 'live-app');
    seed.register(goneWt, 8081, 'gone-app');

    const goneKey = canonicalizePath(goneWt);
    const reg = new PortRegistry(scratch, {
      worktreeExists: (p) => p !== goneKey,
    });

    expect(reg.lookup(liveWt)).toEqual({ port: 8080, containerName: 'live-app' });
    expect(reg.lookup(goneWt)).toBeNull();

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].worktreePath).toBe(canonicalizePath(liveWt));

    const otherWt = path.join(scratch, 'other-worktree');
    mkdirSync(otherWt, { recursive: true });
    expect(() => reg.register(otherWt, 8081, 'other-app')).not.toThrow();
    expect(reg.lookup(otherWt)).toEqual({ port: 8081, containerName: 'other-app' });

    expect(reg.lookup(liveWt)).toEqual({ port: 8080, containerName: 'live-app' });
  });

  it('prunes a genuinely-removed worktree directory via the default filesystem probe', () => {
    const liveWt = path.join(scratch, 'live-worktree');
    const goneWt = path.join(scratch, 'gone-worktree');
    mkdirSync(liveWt, { recursive: true });
    mkdirSync(goneWt, { recursive: true });

    const seed = new PortRegistry(scratch);
    seed.register(liveWt, 9000, 'live-app');
    seed.register(goneWt, 9001, 'gone-app');

    rmSync(goneWt, { recursive: true, force: true });
    expect(existsSync(goneWt)).toBe(false);

    const reg = new PortRegistry(scratch);
    expect(reg.lookup(goneWt)).toBeNull();
    expect(reg.lookup(liveWt)).toEqual({ port: 9000, containerName: 'live-app' });

    const otherWt = path.join(scratch, 'other-worktree');
    mkdirSync(otherWt, { recursive: true });
    expect(() => reg.register(otherWt, 9001, 'other-app')).not.toThrow();
  });

  it('prune persists the reclaimed registry to disk', () => {
    const liveWt = path.join(scratch, 'live-worktree');
    const goneWt = path.join(scratch, 'gone-worktree');
    mkdirSync(liveWt, { recursive: true });
    mkdirSync(goneWt, { recursive: true });

    const seed = new PortRegistry(scratch);
    seed.register(liveWt, 7000, 'live-app');
    seed.register(goneWt, 7001, 'gone-app');

    rmSync(goneWt, { recursive: true, force: true });

    new PortRegistry(scratch).getAll();

    const filePath = moduleStatePath(scratch, 'docker', 'port-registry');
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(onDisk.entries[canonicalizePath(goneWt)]).toBeUndefined();
    expect(onDisk.entries[canonicalizePath(liveWt)]).toEqual({
      port: 7000,
      containerName: 'live-app',
    });
  });

  it('does not prune when every worktree path still exists (no spurious mutation)', () => {
    const wtA = path.join(scratch, 'wt-a');
    const wtB = path.join(scratch, 'wt-b');
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    const seed = new PortRegistry(scratch);
    seed.register(wtA, 6000, 'a');
    seed.register(wtB, 6001, 'b');

    const filePath = moduleStatePath(scratch, 'docker', 'port-registry');
    const before = readFileSync(filePath, 'utf8');

    new PortRegistry(scratch).getAll();

    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });
});

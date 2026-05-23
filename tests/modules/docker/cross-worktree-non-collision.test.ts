

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPort } from '../../../src/modules/docker/PortDiscovery.js';
import { PortRegistry } from '../../../src/modules/docker/PortRegistry.js';
import { nameForWorktree } from '../../../src/modules/docker/ContainerNaming.js';
import {
  _resetModuleRegistrationCacheForTests,
  moduleStatePath,
} from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import {
  addGitWorktree,
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'f8-xwt-modroot-'));
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

describe('F8 cross-worktree non-collision regression', () => {
  let mainRepo: string;
  let worktreeA: string;
  let worktreeB: string;
  let parent: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {

    parent = mkdtempSync(path.join(os.tmpdir(), 'f8-xwt-'));
    mainRepo = path.join(parent, 'main');
    worktreeA = path.join(parent, 'wt-a');
    worktreeB = path.join(parent, 'wt-b');
    mkdirSync(mainRepo, { recursive: true });
    initGitRepo(mainRepo);
    addGitWorktree(mainRepo, worktreeA, 'feature/a');
    addGitWorktree(mainRepo, worktreeB, 'feature/b');

    store = useTempModuleStateStore();
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    stagedRoot = stageDockerModuleRoot();
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  afterEach(() => {
    store.restore();
    rmSync(parent, { recursive: true, force: true });
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

  it('both worktrees of one repo resolve to the SAME shared registry file (fails under per-worktree layout)', () => {

    const pathFromA = moduleStatePath(worktreeA, 'docker', 'port-registry');
    const pathFromB = moduleStatePath(worktreeB, 'docker', 'port-registry');
    expect(pathFromA).toBe(pathFromB);

    expect(pathFromA.startsWith(store.storeRoot + path.sep)).toBe(true);
    expect(pathFromA).not.toContain(path.join('.gan-state', 'modules'));
    expect(pathFromA.startsWith(worktreeA + path.sep)).toBe(false);
    expect(pathFromA.startsWith(worktreeB + path.sep)).toBe(false);
  });

  it("worktree B's registry sees worktree A's allocation and refuses the same host port", () => {

    const regA = new PortRegistry(worktreeA);
    regA.register(worktreeA, 8080, nameForWorktree(worktreeA));

    const regB = new PortRegistry(worktreeB);
    const seenFromB = regB.lookup(worktreeA);
    expect(seenFromB).toEqual({ port: 8080, containerName: nameForWorktree(worktreeA) });

    let caught: unknown = null;
    try {
      regB.register(worktreeB, 8080, nameForWorktree(worktreeB));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('PortInUse');
  });

  it("worktree B's discovery yields a DIFFERENT host port than worktree A's", async () => {
    const regA = new PortRegistry(worktreeA);
    regA.register(worktreeA, 8080, nameForWorktree(worktreeA));

    const regB = new PortRegistry(worktreeB);
    regB.register(worktreeB, 8081, nameForWorktree(worktreeB));

    const portA = await discoverPort({ registry: regB, worktreePath: worktreeA });
    const portB = await discoverPort({ registry: regB, worktreePath: worktreeB });
    expect(portA).toBe(8080);
    expect(portB).toBe(8081);
    expect(portA).not.toBe(portB);
  });

  it('entries stay keyed by canonical worktree path; A and B get distinct ports and container names', () => {
    const regA = new PortRegistry(worktreeA);
    regA.register(worktreeA, 8080, nameForWorktree(worktreeA));
    const regB = new PortRegistry(worktreeB);
    regB.register(worktreeB, 8081, nameForWorktree(worktreeB));

    const all = new PortRegistry(worktreeA).getAll();
    expect(all).toHaveLength(2);
    const keys = all.map((e) => e.worktreePath).sort();
    expect(keys).toEqual([canonicalizePath(worktreeA), canonicalizePath(worktreeB)].sort());

    const ports = all.map((e) => e.port).sort();
    expect(ports).toEqual([8080, 8081]);

    const names = all.map((e) => e.containerName);
    expect(new Set(names).size).toBe(2);

    expect(names).toContain(nameForWorktree(worktreeA));
    expect(names).toContain(nameForWorktree(worktreeB));
  });
});

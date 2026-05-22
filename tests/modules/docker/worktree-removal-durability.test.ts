/**
 * F8 Sprint 2 — durability fix (spec §1): removing a worktree leaves the
 * shared module-state registry byte-intact.
 *
 * Because the registry lives in the central repo-keyed store OUTSIDE any
 * single worktree, deleting one worktree of a repo cannot delete or mutate
 * the registry file. This is the durability half of F8's motivation, and
 * it is DISTINCT from prune-on-load: removal alone must not touch the file;
 * only a *subsequent load* performs reclamation. These tests therefore
 * capture the registry bytes, remove a worktree WITHOUT performing a load,
 * and assert the on-disk file is byte-for-byte identical afterwards.
 */

import { createHash } from 'node:crypto';
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
  addGitWorktree,
  initGitRepo,
  removeGitWorktree,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'f8-durability-modroot-'));
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

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe('F8 worktree removal leaves the shared registry byte-intact', () => {
  let parent: string;
  let mainRepo: string;
  let worktreeA: string;
  let worktreeB: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    parent = mkdtempSync(path.join(os.tmpdir(), 'f8-durability-'));
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

  it('git worktree remove leaves the registry file present and byte-for-byte identical', () => {
    // Both worktrees register against the one shared repo-keyed registry.
    const reg = new PortRegistry(mainRepo);
    reg.register(worktreeA, 8080, 'app-a');
    reg.register(worktreeB, 8081, 'app-b');

    const filePath = moduleStatePath(mainRepo, 'docker', 'port-registry');
    expect(existsSync(filePath)).toBe(true);
    const before = readFileSync(filePath);
    const beforeHash = sha256OfFile(filePath);
    // Capture the canonical entry keys WHILE the worktrees still exist;
    // canonicalizePath realpath-resolves, so it would change once a dir
    // is gone. The on-disk keys, however, do not change on removal.
    const keyA = canonicalizePath(worktreeA);
    const keyB = canonicalizePath(worktreeB);

    // Remove worktree A via real git worktree remove. No registry load is
    // performed, so no prune runs: removal alone must not mutate the file.
    removeGitWorktree(mainRepo, worktreeA);
    expect(existsSync(worktreeA)).toBe(false);

    // The shared registry file still exists at the repo-keyed location and
    // its bytes are unchanged — it lives outside the removed worktree.
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(before)).toBe(true);
    expect(sha256OfFile(filePath)).toBe(beforeHash);
    // Both entries are still on disk under their original keys (no prune
    // happened on removal).
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(onDisk.entries[keyA]).toEqual({ port: 8080, containerName: 'app-a' });
    expect(onDisk.entries[keyB]).toEqual({ port: 8081, containerName: 'app-b' });
  });

  it('removal followed by a load (prune) is what reclaims — proving removal alone did not', () => {
    const reg = new PortRegistry(mainRepo);
    reg.register(worktreeA, 8080, 'app-a');
    reg.register(worktreeB, 8081, 'app-b');

    const filePath = moduleStatePath(mainRepo, 'docker', 'port-registry');
    const beforeHash = sha256OfFile(filePath);

    removeGitWorktree(mainRepo, worktreeA);

    // Still byte-intact immediately after removal (no load yet).
    expect(sha256OfFile(filePath)).toBe(beforeHash);

    // Only NOW, on a subsequent load, does prune-on-load reclaim A's entry.
    const after = new PortRegistry(mainRepo);
    expect(after.lookup(worktreeA)).toBeNull();
    expect(after.lookup(worktreeB)).toEqual({ port: 8081, containerName: 'app-b' });
  });
});

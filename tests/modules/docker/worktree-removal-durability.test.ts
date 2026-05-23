// F8 durability: running `git worktree remove` must NOT, by itself, touch the shared
// port registry. Reclaiming the removed worktree's port is the job of prune-on-load
// (covered in prune-on-load.test.ts), and the two responsibilities must stay separate.
// This suite asserts that after a worktree is removed the registry file is still
// present and byte-for-byte identical (same bytes AND same sha256), then shows that a
// SUBSEQUENT PortRegistry load is what actually reclaims the entry — proving the
// removal alone did nothing. Conflating the two would risk mutating shared state from a
// git operation that has no business writing to it.
//
// Uses a real repo with two `git worktree add` checkouts plus a staged install and
// temp module-state store, so the shared registry lives in a repo-keyed sandbox.

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

// Stage a throwaway install: real package.json (for package-root detection) plus a
// docker manifest declaring the port-registry state key, so the registry resolves.
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
    // Register both worktrees through a registry rooted at the shared repo, then snapshot
    // the file's raw bytes and hash as the baseline.
    const reg = new PortRegistry(mainRepo);
    reg.register(worktreeA, 8080, 'app-a');
    reg.register(worktreeB, 8081, 'app-b');

    const filePath = moduleStatePath(mainRepo, 'docker', 'port-registry');
    expect(existsSync(filePath)).toBe(true);
    const before = readFileSync(filePath);
    const beforeHash = sha256OfFile(filePath);

    const keyA = canonicalizePath(worktreeA);
    const keyB = canonicalizePath(worktreeB);

    // Remove worktreeA via git; this deletes the checkout but must not write the registry.
    removeGitWorktree(mainRepo, worktreeA);
    expect(existsSync(worktreeA)).toBe(false);

    // File still exists and is unchanged — checked both by raw-byte equality and by hash.
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(before)).toBe(true);
    expect(sha256OfFile(filePath)).toBe(beforeHash);

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

    // Removal alone changed nothing on disk...
    expect(sha256OfFile(filePath)).toBe(beforeHash);

    // ...it is the next load (prune-on-load) that drops the now-absent worktreeA entry,
    // while the still-present worktreeB entry is retained. This ordering is the proof
    // that reclaim is a load-time concern, not a side effect of `git worktree remove`.
    const after = new PortRegistry(mainRepo);
    expect(after.lookup(worktreeA)).toBeNull();
    expect(after.lookup(worktreeB)).toEqual({ port: 8081, containerName: 'app-b' });
  });
});

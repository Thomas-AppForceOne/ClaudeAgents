/**
 * F8 Sprint 2 — cross-worktree non-collision regression (the central
 * correctness fix).
 *
 * M2 promised that two `/gan` runs in *different worktrees of the same
 * repo* would not collide on host ports, "because PortRegistry refuses
 * duplicates". Under the pre-F8 per-worktree layout that promise was
 * silently broken: each worktree kept its own
 * `<projectRoot>/.gan-state/modules/docker/port-registry.json`, blind to
 * the other's allocations, so both could hand out the same host port.
 *
 * F8 relocates the registry into the central repo-keyed store. Because
 * every linked worktree of a repo shares one git-common-dir, both
 * worktrees derive the SAME repo-key and therefore resolve to ONE shared
 * `port-registry.json`. This test constructs two REAL linked worktrees of
 * one repo and proves:
 *
 *   1. Both worktrees resolve to the same on-disk registry file (the
 *      property that fails under the per-worktree layout — there the two
 *      paths differ because each is anchored to its own worktree dir).
 *   2. After worktree A registers host port P, a freshly-constructed
 *      PortRegistry pointed at worktree B sees A's allocation, so B's
 *      attempt to register the SAME port P is refused with PortInUse and
 *      B's port discovery yields a DIFFERENT host port.
 *   3. Entries stay keyed by canonical worktree path, so A and B receive
 *      distinct ports and distinct container names.
 *
 * The assertion in (1) is the explicit guard that this test would FAIL
 * under the pre-F8 per-worktree layout: under that layout A's and B's
 * registries are distinct files, B's fresh registry would NOT observe
 * A's entry, and the shared-file equality would not hold.
 */

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

/**
 * Stage a fake package root with the docker module's manifest so the M3
 * `stateKeys` allowlist gate finds `port-registry` as a declared state
 * key when PortRegistry routes writes through `setModuleState`.
 */
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
    // A parent temp dir holds the main checkout plus the two linked
    // worktrees as siblings (a worktree cannot nest inside the repo it
    // links to). The main checkout is a real git repo; A and B are real
    // linked worktrees of it, so all three share one git-common-dir.
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
    // The crux of the regression: under F8 the repo-key is derived from
    // the shared git-common-dir, so the registry path is identical no
    // matter which worktree it is resolved from. Under the pre-F8
    // per-worktree layout (`<projectRoot>/.gan-state/modules/...`) these
    // two paths would DIFFER, and this assertion would fail.
    const pathFromA = moduleStatePath(worktreeA, 'docker', 'port-registry');
    const pathFromB = moduleStatePath(worktreeB, 'docker', 'port-registry');
    expect(pathFromA).toBe(pathFromB);
    // And the shared file lives in the repo-keyed store, not under either
    // worktree's `.gan-state/modules`.
    expect(pathFromA.startsWith(store.storeRoot + path.sep)).toBe(true);
    expect(pathFromA).not.toContain(path.join('.gan-state', 'modules'));
    expect(pathFromA.startsWith(worktreeA + path.sep)).toBe(false);
    expect(pathFromA.startsWith(worktreeB + path.sep)).toBe(false);
  });

  it("worktree B's registry sees worktree A's allocation and refuses the same host port", () => {
    // Worktree A registers host port 8080.
    const regA = new PortRegistry(worktreeA);
    regA.register(worktreeA, 8080, nameForWorktree(worktreeA));

    // A FRESH registry, pointed at worktree B, observes A's entry — only
    // possible because both resolve to the one shared file.
    const regB = new PortRegistry(worktreeB);
    const seenFromB = regB.lookup(worktreeA);
    expect(seenFromB).toEqual({ port: 8080, containerName: nameForWorktree(worktreeA) });

    // B trying to take the SAME port is refused by M2's duplicate-refusal.
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

    // B picks a different port (here via its own register) and a fresh
    // registry confirms both allocations coexist in the shared file.
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

    // A single shared registry holds both, keyed by canonical worktree path.
    const all = new PortRegistry(worktreeA).getAll();
    expect(all).toHaveLength(2);
    const keys = all.map((e) => e.worktreePath).sort();
    expect(keys).toEqual([canonicalizePath(worktreeA), canonicalizePath(worktreeB)].sort());

    const ports = all.map((e) => e.port).sort();
    expect(ports).toEqual([8080, 8081]);

    const names = all.map((e) => e.containerName);
    expect(new Set(names).size).toBe(2);
    // ContainerNaming determinism on worktree path is unchanged.
    expect(names).toContain(nameForWorktree(worktreeA));
    expect(names).toContain(nameForWorktree(worktreeB));
  });
});

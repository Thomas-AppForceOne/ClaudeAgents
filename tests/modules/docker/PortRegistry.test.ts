// Contract for PortRegistry — the durable map from canonical worktree path to its
// allocated { port, containerName }. The suite verifies the core CRUD round-trips
// (register/lookup/getAll/release), the on-disk shape ({ version: 1, entries }),
// and the cross-instance durability that makes the registry a source of truth:
// a freshly constructed PortRegistry must read back state another instance wrote.
// A no-op release on an unregistered worktree must not throw.
//
// The final test is an architectural guard, not a behaviour test: PortRegistry must
// route all persistence through the M1 module-state API (setModuleState/loadModuleState)
// and must NOT import file-IO helpers (atomicWriteFile, readFileSync, writeFileSync)
// directly — only existsSync from node:fs is permitted (for the worktree-exists
// prune probe). This keeps a single owner of the state file's bytes and locking.
//
// Tests use a staged fake package root plus a temp module-state store so the
// repo-keyed state path lands in a sandbox, never the developer's real ~/.gan state.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PortRegistry, type PortRegistryFile } from '../../../src/modules/docker/PortRegistry.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import {
  _resetModuleRegistrationCacheForTests,
  moduleStatePath,
} from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// Stage a throwaway install: real package.json (for package-root detection) plus a
// docker manifest declaring the port-registry state key, so the registry resolves.
function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm2-portreg-modroot-'));
  const realPkg = path.join(repoRoot, 'package.json');
  writeFileSync(path.join(root, 'package.json'), readFileSync(realPkg, 'utf8'));
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

describe('PortRegistry', () => {
  let scratch: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-portregistry-'));

    // State paths are keyed by repo root, so the scratch dir must be a git repo.
    initGitRepo(scratch);
    store = useTempModuleStateStore();
    // Point package-root resolution at the staged install; save prior env to restore.
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    stagedRoot = stageDockerModuleRoot();
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    // Drop memoised package-root and module-registration caches so the override applies.
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

  it('constructor takes a project root (string)', () => {
    const reg = new PortRegistry(scratch);
    expect(reg).toBeInstanceOf(PortRegistry);
  });

  it('register + lookup round-trip', () => {
    const reg = new PortRegistry(scratch);
    const wt = path.join(scratch, 'worktree-a');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 8080, 'app-a');
    const found = reg.lookup(wt);
    expect(found).toEqual({ port: 8080, containerName: 'app-a' });
  });

  it('lookup returns null when worktree was never registered', () => {
    const reg = new PortRegistry(scratch);
    expect(reg.lookup(path.join(scratch, 'nope'))).toBeNull();
  });

  it('getAll returns array of all entries', () => {
    const reg = new PortRegistry(scratch);
    const wtA = path.join(scratch, 'wt-a');
    const wtB = path.join(scratch, 'wt-b');
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    reg.register(wtA, 8080, 'app-a');
    reg.register(wtB, 8081, 'app-b');
    const all = reg.getAll();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(2);
    const names = all.map((e) => e.containerName).sort();
    expect(names).toEqual(['app-a', 'app-b']);
  });

  it('release removes an entry', () => {
    const reg = new PortRegistry(scratch);
    const wt = path.join(scratch, 'wt-x');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 9000, 'app-x');
    expect(reg.lookup(wt)).not.toBeNull();
    // release() returns true when an entry was actually removed.
    expect(reg.release(wt)).toBe(true);
    expect(reg.lookup(wt)).toBeNull();
    expect(reg.getAll()).toHaveLength(0);
  });

  it('on-disk JSON matches {version: 1, entries: {...}} shape at the repo-keyed module-state path', () => {
    const reg = new PortRegistry(scratch);
    const wt = path.join(scratch, 'wt-disk');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 7000, 'app-disk');

    // The state file must live under the temp store (the M1-owned location), not
    // inside the repo's own .gan-state/modules tree — that older per-repo layout is
    // exactly what the temp store replaces, hence the negative assertion.
    const filePath = moduleStatePath(scratch, 'docker', 'port-registry');
    expect(filePath).toBe(store.statePath(scratch, 'docker', 'port-registry'));
    expect(filePath.startsWith(store.storeRoot + path.sep)).toBe(true);
    expect(filePath).not.toContain(path.join('.gan-state', 'modules'));
    expect(filePath.endsWith(path.join('docker', 'port-registry.json'))).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as PortRegistryFile;
    expect(onDisk.version).toBe(1);
    expect(typeof onDisk.entries).toBe('object');
    // Entries are keyed by the CANONICAL path, not the raw input path.
    const canonKey = canonicalizePath(wt);
    expect(onDisk.entries[canonKey]).toEqual({ port: 7000, containerName: 'app-disk' });
  });

  it('release on absent worktree is a silent no-op', () => {
    const reg = new PortRegistry(scratch);
    // No throw, and the boolean return reflects the no-op (false), not a
    // hardcoded success — the field is a real state observation.
    expect(reg.release(path.join(scratch, 'never-registered'))).toBe(false);
  });

  // Durability across instances: state survives in the file, not in object memory.
  // regB reads what regA wrote; after regB releases wtA, a third instance regC sees
  // the release — proving every mutation is flushed and every construction reloads.
  it('a fresh PortRegistry instance reads state persisted by a previous instance', () => {
    const wtA = path.join(scratch, 'wt-cross-a');
    mkdirSync(wtA, { recursive: true });
    const wtB = path.join(scratch, 'wt-cross-b');
    mkdirSync(wtB, { recursive: true });
    const regA = new PortRegistry(scratch);
    regA.register(wtA, 7100, 'cross-a');
    regA.register(wtB, 7101, 'cross-b');
    const regB = new PortRegistry(scratch);
    expect(regB.lookup(wtA)).toEqual({ port: 7100, containerName: 'cross-a' });
    expect(regB.lookup(wtB)).toEqual({ port: 7101, containerName: 'cross-b' });
    regB.release(wtA);
    const regC = new PortRegistry(scratch);
    expect(regC.lookup(wtA)).toBeNull();
    expect(regC.lookup(wtB)).toEqual({ port: 7101, containerName: 'cross-b' });
  });

  // Architectural guard enforced by reading the source's import lines (not behaviour).
  it('does not import the registry-file IO helpers directly (routes through M1)', async () => {
    // Inspect only `import` lines so a stray identifier in the body never trips this.
    const src = readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'modules', 'docker', 'PortRegistry.ts'),
      'utf8',
    );
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    // Forbidden: any direct file-write path that would bypass M1's owned persistence.
    expect(imports).not.toMatch(/atomicWriteFile/);
    expect(imports).not.toMatch(/readFileSync/);
    expect(imports).not.toMatch(/writeFileSync/);
    // Required: persistence must go through the M1 module-state API.
    expect(imports).toMatch(/setModuleState/);
    expect(imports).toMatch(/loadModuleState/);

    // node:fs is allowed ONLY for existsSync (the worktree-exists prune probe);
    // any read/write/readdir/appendFile from node:fs is a layering violation.
    const fsImportLines = imports.split('\n').filter((l) => /from ['"]node:fs['"]/.test(l));
    for (const line of fsImportLines) {
      expect(line).toMatch(/existsSync/);
      expect(line).not.toMatch(/readFile|writeFile|readdir|appendFile/);
    }
  });
});

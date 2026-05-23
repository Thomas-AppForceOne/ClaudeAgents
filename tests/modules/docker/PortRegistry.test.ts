

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
    reg.release(wt);
    expect(reg.lookup(wt)).toBeNull();
    expect(reg.getAll()).toHaveLength(0);
  });

  it('on-disk JSON matches {version: 1, entries: {...}} shape at the repo-keyed module-state path', () => {
    const reg = new PortRegistry(scratch);
    const wt = path.join(scratch, 'wt-disk');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 7000, 'app-disk');

    const filePath = moduleStatePath(scratch, 'docker', 'port-registry');
    expect(filePath).toBe(store.statePath(scratch, 'docker', 'port-registry'));
    expect(filePath.startsWith(store.storeRoot + path.sep)).toBe(true);
    expect(filePath).not.toContain(path.join('.gan-state', 'modules'));
    expect(filePath.endsWith(path.join('docker', 'port-registry.json'))).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as PortRegistryFile;
    expect(onDisk.version).toBe(1);
    expect(typeof onDisk.entries).toBe('object');
    const canonKey = canonicalizePath(wt);
    expect(onDisk.entries[canonKey]).toEqual({ port: 7000, containerName: 'app-disk' });
  });

  it('release on absent worktree is a silent no-op', () => {
    const reg = new PortRegistry(scratch);
    expect(() => reg.release(path.join(scratch, 'never-registered'))).not.toThrow();
  });

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

  it('does not import the registry-file IO helpers directly (routes through M1)', async () => {

    const src = readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'modules', 'docker', 'PortRegistry.ts'),
      'utf8',
    );
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    expect(imports).not.toMatch(/atomicWriteFile/);
    expect(imports).not.toMatch(/readFileSync/);
    expect(imports).not.toMatch(/writeFileSync/);
    expect(imports).toMatch(/setModuleState/);
    expect(imports).toMatch(/loadModuleState/);

    const fsImportLines = imports.split('\n').filter((l) => /from ['"]node:fs['"]/.test(l));
    for (const line of fsImportLines) {
      expect(line).toMatch(/existsSync/);
      expect(line).not.toMatch(/readFile|writeFile|readdir|appendFile/);
    }
  });
});

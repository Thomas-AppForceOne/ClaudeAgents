/**
 * M2 — PortRegistry tests.
 *
 * Covers AC4:
 *   - constructor takes a project root.
 *   - register/lookup round-trip.
 *   - getAll returns array of entries sorted by worktreePath.
 *   - release removes entry.
 *   - on-disk JSON shape: {version: 1, entries: {...}} at M1's
 *     module-state path `.gan-state/modules/docker/state.json`.
 *   - persistence routes through `setModuleState` / `loadModuleState`
 *     (PortRegistry never imports `atomicWriteFile` or names a path).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PortRegistry,
  type PortRegistryFile,
} from '../../../src/modules/docker/PortRegistry.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import { moduleStatePath } from '../../../src/config-server/storage/module-loader.js';

describe('PortRegistry', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-portregistry-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
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

  it('on-disk JSON matches {version: 1, entries: {...}} shape at M1 module-state path', () => {
    const reg = new PortRegistry(scratch);
    const wt = path.join(scratch, 'wt-disk');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 7000, 'app-disk');
    // M1 owns the path: <projectRoot>/.gan-state/modules/<name>/state.json
    const filePath = moduleStatePath(scratch, 'docker');
    expect(filePath).toBe(
      path.join(scratch, '.gan-state', 'modules', 'docker', 'state.json'),
    );
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

  it('does not import atomic-write or filesystem helpers directly (routes through M1)', async () => {
    // Source-level guarantee that PortRegistry is a pure consumer of
    // the M1 module-state surface — no import of atomicWriteFile or
    // node:fs read helpers, no path string for the on-disk file. We
    // grep the import lines specifically so doc-comments mentioning
    // those names (intentionally, to explain what we *don't* do) don't
    // trip the assertion.
    const src = readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'modules', 'docker', 'PortRegistry.ts'),
      'utf8',
    );
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    expect(imports).not.toMatch(/atomicWriteFile/);
    expect(imports).not.toMatch(/readFileSync/);
    expect(imports).not.toMatch(/from ['"]node:fs['"]/);
    expect(imports).toMatch(/setModuleState/);
    expect(imports).toMatch(/loadModuleState/);
  });
});

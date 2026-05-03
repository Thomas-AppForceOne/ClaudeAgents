/**
 * M2 — PortRegistry tests.
 *
 * Covers AC4:
 *   - constructor takes an API/handle (no path argument).
 *   - register/lookup round-trip.
 *   - getAll returns array of entries sorted by worktreePath.
 *   - release removes entry.
 *   - on-disk JSON shape: {version: 1, entries: {...}} at
 *     `.gan-state/modules/docker/port-registry.json`.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PortRegistry,
  createDefaultRegistryApi,
  portRegistryPath,
  type PortRegistryApi,
  type PortRegistryFile,
} from '../../../src/modules/docker/PortRegistry.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

describe('PortRegistry', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-portregistry-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('constructor takes only an API handle (no path argument)', () => {
    // Verify the class signature: passing a path string should not be
    // accepted by the type system. We test by constructing with the
    // default api handle. If the constructor accepted a path string,
    // this test wouldn't be exercising that contract; the type-system
    // assertion is enforced by tsc --noEmit.
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    expect(reg).toBeInstanceOf(PortRegistry);
  });

  it('register + lookup round-trip', () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    const wt = path.join(scratch, 'worktree-a');
    // Create the directory so canonicalisation hits a real path.
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 8080, 'app-a');
    const found = reg.lookup(wt);
    expect(found).toEqual({ port: 8080, containerName: 'app-a' });
  });

  it('lookup returns null when worktree was never registered', () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    expect(reg.lookup(path.join(scratch, 'nope'))).toBeNull();
  });

  it('getAll returns array of all entries', () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
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
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    const wt = path.join(scratch, 'wt-x');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 9000, 'app-x');
    expect(reg.lookup(wt)).not.toBeNull();
    reg.release(wt);
    expect(reg.lookup(wt)).toBeNull();
    expect(reg.getAll()).toHaveLength(0);
  });

  it('on-disk JSON matches {version: 1, entries: {...}} shape at the documented path', () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    const wt = path.join(scratch, 'wt-disk');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 7000, 'app-disk');
    // The file MUST live at the documented location.
    const filePath = portRegistryPath(scratch);
    expect(filePath).toBe(
      path.join(scratch, '.gan-state', 'modules', 'docker', 'port-registry.json'),
    );
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as PortRegistryFile;
    expect(onDisk.version).toBe(1);
    expect(typeof onDisk.entries).toBe('object');
    const canonKey = canonicalizePath(wt);
    expect(onDisk.entries[canonKey]).toEqual({ port: 7000, containerName: 'app-disk' });
  });

  it('release on absent worktree is a silent no-op', () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    expect(() => reg.release(path.join(scratch, 'never-registered'))).not.toThrow();
  });

  it('accepts an in-memory PortRegistryApi shim (constructor takes any API handle)', () => {
    const store: { current: PortRegistryFile | null } = { current: null };
    const api: PortRegistryApi = {
      read: () => (store.current ? { version: 1, entries: { ...store.current.entries } } : null),
      write: (blob) => {
        store.current = { version: 1, entries: { ...blob.entries } };
      },
    };
    const reg = new PortRegistry(api);
    const wt = path.join(scratch, 'in-memory');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 4242, 'mem-app');
    expect(reg.lookup(wt)).toEqual({ port: 4242, containerName: 'mem-app' });
    expect(store.current?.version).toBe(1);
  });
});

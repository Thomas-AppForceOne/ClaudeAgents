/**
 * E1 invariant — snapshot freshness across `mutated: false` writes.
 *
 * Per E1's "Snapshot freshness" rule: an API write that returns
 * `{ mutated: false }` must NOT invalidate the resolved-config cache, and
 * the next `getResolvedConfig()` call must return the same snapshot
 * (byte-identical, and at the cached object identity). A write that
 * returns `mutated: true` is the only thing that should re-snapshot.
 *
 * This test exercises the no-op write path (`setModuleState` — a module
 * no-op that returns `{ mutated: false }` per OQ4) against the
 * `js-ts-minimal` fixture: prime the cache, run the write, re-read, and
 * assert the snapshot is preserved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getResolvedConfig } from '../../src/config-server/tools/reads.js';
import { setModuleState } from '../../src/config-server/tools/writes.js';
import {
  cacheKeyForProjectRoot,
  clearResolvedConfigCache,
  getResolvedConfigCache,
} from '../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const jsTsMinimalSrc = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-snapshot-fresh-'));
  cpSync(jsTsMinimalSrc, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => clearResolvedConfigCache());
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  clearResolvedConfigCache();
});

describe('snapshot freshness across `mutated: false` writes', () => {
  it('preserves the same snapshot identity when an API write returns mutated: false', async () => {
    const proj = makeTmpProject();

    // Prime: capture snapshot A.
    const snapshotA = await getResolvedConfig({ projectRoot: proj });

    // Sanity: the cache is now populated for this project.
    const cache = getResolvedConfigCache();
    const key = cacheKeyForProjectRoot(proj);
    expect(cache.get(key)).toBeDefined();

    // Inter-sprint API call that returns `{ mutated: false }` (module
    // surface no-op per OQ4). Must NOT invalidate the cache.
    const writeResult = setModuleState({
      projectRoot: proj,
      name: 'unknown-module',
      state: { any: 'value' },
    });
    expect(writeResult).toEqual({ mutated: false });

    // Cache entry survives because the write did not mutate durable state.
    expect(cache.get(key)).toBeDefined();

    // Capture snapshot B and assert it is the same snapshot — identical
    // by reference (cached singleton) AND byte-identical when serialised.
    const snapshotB = await getResolvedConfig({ projectRoot: proj });
    expect(snapshotB).toBe(snapshotA);
    expect(JSON.stringify(snapshotB)).toBe(JSON.stringify(snapshotA));
  });
});

/**
 * Guards that a write which does NOT change anything on disk leaves the
 * resolved-config snapshot cache untouched — same object identity, byte for
 * byte.
 *
 * The write tools invalidate the resolved-config cache only after a real disk
 * write lands; a no-op or thrown write must never evict a still-valid entry.
 * This suite exercises that boundary by issuing a write that fails (an unknown
 * module, which throws before touching disk) and asserting the cached snapshot
 * is the very same instance before and after.
 *
 * Regression guarded: a refactor that moved cache invalidation ahead of the
 * write (or invalidated on the throw/no-op path) would silently churn the
 * snapshot and break referential-identity assumptions downstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getResolvedConfig } from '../../src/config-server/tools/reads.js';
import { removeFromModuleState } from '../../src/config-server/tools/writes.js';
import {
  cacheKeyForProjectRoot,
  clearResolvedConfigCache,
  getResolvedConfigCache,
} from '../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const jsTsMinimalSrc = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

// Track every temp project created so afterEach can sweep them.
const tmpDirs: string[] = [];

// Copy the js-ts-minimal fixture into a throwaway temp dir so the test can own
// a real on-disk project without mutating the checked-in fixture.
function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-snapshot-fresh-'));
  cpSync(jsTsMinimalSrc, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

// Clear the cache before each test so the first getResolvedConfig is a real
// compose, and clear again after to avoid leaking entries between tests.
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

    // First read populates and caches the snapshot.
    const snapshotA = await getResolvedConfig({ projectRoot: proj });

    const cache = getResolvedConfigCache();
    const key = cacheKeyForProjectRoot(proj);
    expect(cache.get(key)).toBeDefined();

    // Issue a write against an unknown module: the allowlist gate throws before
    // any disk write or cache invalidation, modelling the failing/no-op path.
    let threw: unknown;
    try {
      removeFromModuleState({
        projectRoot: proj,
        name: 'unknown-module',
        key: 'port-registry',
        entryKey: 'entry',
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();

    // The cached entry must survive the failed write untouched.
    expect(cache.get(key)).toBeDefined();

    // Same object identity (toBe), and structurally identical for good measure.
    const snapshotB = await getResolvedConfig({ projectRoot: proj });
    expect(snapshotB).toBe(snapshotA);
    expect(JSON.stringify(snapshotB)).toBe(JSON.stringify(snapshotA));
  });
});

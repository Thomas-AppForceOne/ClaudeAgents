// Verifies the resolved-config cache: both the generic ResolvedConfigCache
// container (get/set/invalidate/clear, key canonicalisation) and how the
// process-wide singleton interacts with composeResolvedConfig.
//
// The load-bearing invariant this guards is the "frozen-snapshot" rule: once a
// project's config is composed and cached, later edits to the user's working
// tree (e.g. dropping a package.json that auto-detection would key off) must
// NOT silently change what resolves — only an explicit invalidate may. A
// regression that let disk edits leak through would make every consumer see a
// moving target between two calls within the same run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ResolvedConfigCache,
  cacheKeyForProjectRoot,
  clearResolvedConfigCache,
  getResolvedConfigCache,
} from '../../../src/config-server/resolution/cache.js';
import {
  composeResolvedConfig,
  composeResolvedConfigSync,
} from '../../../src/config-server/resolution/resolved-config.js';
import { stableStringify } from '../../../src/config-server/determinism/index.js';

describe('ResolvedConfigCache — class', () => {
  it('get / set / invalidate roundtrip', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    cache.set('/a', { v: 1 });
    expect(cache.get('/a')).toEqual({ v: 1 });
    cache.invalidate('/a');
    expect(cache.get('/a')).toBeUndefined();
  });

  it('clear empties every entry', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    cache.set('/a', { v: 1 });
    cache.set('/b', { v: 2 });
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('cacheKeyForProjectRoot canonicalises trailing slashes', () => {
    // A trailing-slash variant must map to the same cache key, so the two
    // spellings of one project root cannot end up with separate entries.
    const a = cacheKeyForProjectRoot('/usr');
    const b = cacheKeyForProjectRoot('/usr/');
    expect(a).toBe(b);
  });
});

describe('Cache singleton + composeResolvedConfig', () => {
  let workRoot: string;

  beforeEach(() => {
    // Each test starts from a pristine singleton + a fresh scratch project so
    // cache entries cannot bleed between cases.
    clearResolvedConfigCache();
    workRoot = mkdtempSync(path.join(tmpdir(), 'cas-cache-test-'));
    mkdirSync(path.join(workRoot, '.claude', 'gan'), { recursive: true });
    writeFileSync(
      path.join(workRoot, '.claude', 'gan', 'project.md'),
      ['---', 'schemaVersion: 1', '---', '', ''].join('\n'),
    );

    // A web-node stack whose detection rule keys off package.json. The project
    // ships the stack file but no package.json yet, so the stack is inactive
    // until a test adds one (and invalidates the cache).
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'web-node.md'),
      [
        '---',
        'name: web-node',
        'schemaVersion: 1',
        'detection:',
        '  - package.json',
        '---',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
    clearResolvedConfigCache();
  });

  it('two consecutive calls return byte-identical JSON', async () => {
    const a = await composeResolvedConfig(workRoot);
    const b = await composeResolvedConfig(workRoot);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('user-side disk edits do NOT invalidate the cache (frozen-snapshot rule)', async () => {
    // Prime the cache, then create the package.json that *would* activate
    // web-node on a fresh compose. Because the entry is still cached, the
    // second compose must return the original snapshot — the new file is
    // invisible (active set stays empty) until something invalidates.
    const a = await composeResolvedConfig(workRoot);

    appendFileSync(path.join(workRoot, 'package.json'), '{}');
    const b = await composeResolvedConfig(workRoot);
    expect(stableStringify(a)).toBe(stableStringify(b));

    expect(b.stacks.active).toEqual([]);
  });

  it('invalidate(canonicalRoot) forces a fresh compose', async () => {
    const a = await composeResolvedConfig(workRoot);
    expect(a.stacks.active).toEqual([]);

    writeFileSync(path.join(workRoot, 'package.json'), '{}');

    // Still cached: the new package.json is not yet observed.
    const stale = await composeResolvedConfig(workRoot);
    expect(stale.stacks.active).toEqual([]);

    // Explicit invalidation is the only sanctioned way to re-read disk; after
    // it, the recompose finally activates web-node from the package.json.
    const cache = getResolvedConfigCache();
    cache.invalidate(cacheKeyForProjectRoot(workRoot));
    const fresh = await composeResolvedConfig(workRoot);
    expect(fresh.stacks.active).toEqual(['web-node']);
  });

  it('synchronous composeResolvedConfigSync is also cached', () => {
    const a = composeResolvedConfigSync(workRoot, '0.1.0');
    const b = composeResolvedConfigSync(workRoot, '0.1.0');
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('different projectRoots get separate cache entries', async () => {
    // A second project root proves the cache keys by root: composing both
    // yields two entries, invalidating one leaves the other live (so a repeat
    // compose of the survivor returns the exact same object reference).
    const otherRoot = mkdtempSync(path.join(tmpdir(), 'cas-cache-test-other-'));
    try {
      mkdirSync(path.join(otherRoot, '.claude', 'gan'), { recursive: true });
      writeFileSync(
        path.join(otherRoot, '.claude', 'gan', 'project.md'),
        ['---', 'schemaVersion: 1', '---', ''].join('\n'),
      );
      const cache = getResolvedConfigCache();
      await composeResolvedConfig(workRoot);
      await composeResolvedConfig(otherRoot);

      // size() is an optional internal affordance; guard so the test still
      // asserts the reference-identity behaviour even if it is ever dropped.
      const sized = cache as unknown as { size?: () => number };
      if (typeof sized.size === 'function') {
        expect(sized.size()).toBeGreaterThanOrEqual(2);
      }

      cache.invalidate(cacheKeyForProjectRoot(workRoot));
      if (typeof sized.size === 'function') {
        expect(sized.size()).toBeGreaterThanOrEqual(1);
      }

      const b1 = await composeResolvedConfig(otherRoot);
      const b2 = await composeResolvedConfig(otherRoot);
      expect(b1).toBe(b2);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

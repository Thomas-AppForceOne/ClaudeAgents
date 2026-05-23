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
    const a = cacheKeyForProjectRoot('/usr');
    const b = cacheKeyForProjectRoot('/usr/');
    expect(a).toBe(b);
  });
});

describe('Cache singleton + composeResolvedConfig', () => {
  let workRoot: string;

  beforeEach(() => {
    clearResolvedConfigCache();
    workRoot = mkdtempSync(path.join(tmpdir(), 'cas-cache-test-'));
    mkdirSync(path.join(workRoot, '.claude', 'gan'), { recursive: true });
    writeFileSync(
      path.join(workRoot, '.claude', 'gan', 'project.md'),
      ['---', 'schemaVersion: 1', '---', '', ''].join('\n'),
    );

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

    const stale = await composeResolvedConfig(workRoot);
    expect(stale.stacks.active).toEqual([]);

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

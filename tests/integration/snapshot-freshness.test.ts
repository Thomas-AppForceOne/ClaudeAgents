
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

    const snapshotA = await getResolvedConfig({ projectRoot: proj });

    const cache = getResolvedConfigCache();
    const key = cacheKeyForProjectRoot(proj);
    expect(cache.get(key)).toBeDefined();

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

    expect(cache.get(key)).toBeDefined();

    const snapshotB = await getResolvedConfig({ projectRoot: proj });
    expect(snapshotB).toBe(snapshotA);
    expect(JSON.stringify(snapshotB)).toBe(JSON.stringify(snapshotA));
  });
});

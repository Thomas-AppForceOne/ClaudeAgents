import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getActiveStacks,
  getMergedSplicePoints,
  getModuleState,
  getOverlay,
  getResolvedConfig,
  getStack,
  getStackResolution,
  getTrustDiff,
  getTrustState,
  listModules,
} from '../../../src/config-server/tools/reads.js';
import { getApiVersion } from '../../../src/config-server/index.js';
import type { Logger } from '../../../src/config-server/logging/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

interface RecordedEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

function makeSpyLogger(): { logger: Logger; entries: RecordedEntry[] } {
  const entries: RecordedEntry[] = [];
  const logger: Logger = {
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    sink: () => 'spy',
  };
  return { logger, entries };
}

describe('S2 read tools (one positive test per tool)', () => {
  it('getApiVersion returns a semver-shaped string', async () => {
    const result = await getApiVersion();
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('getResolvedConfig returns the full F2 shape', async () => {
    // Reset the cache to make this test order-independent.
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    const result = await getResolvedConfig({ projectRoot: jsTsMinimal });
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.schemaVersions).toEqual({ stack: 1, overlay: 1 });
    // js-ts-minimal has no package.json/tsconfig.json on disk, so detection
    // produces an empty active set (no `generic` stack ships either).
    expect(result.stacks.active).toEqual([]);
    expect(result.stacks.byName).toEqual({});
    // Overlay is the cascaded view; js-ts-minimal's project overlay only
    // declares schemaVersion (which is filtered out), so the merged
    // overlay is empty.
    expect(result.overlay).toEqual({});
    expect(result.discarded).toEqual([]);
    expect(result.additionalContext.planner).toEqual([]);
    expect(result.additionalContext.proposer).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('getStack loads a stack with tier provenance', () => {
    const result = getStack({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.sourceTier).toBe('builtin');
    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe('web-node');
  });

  it('getActiveStacks returns the detected active set (empty for js-ts-minimal)', async () => {
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    // js-ts-minimal has no package.json on disk; detection returns empty.
    const result = getActiveStacks({ projectRoot: jsTsMinimal });
    expect(result.active).toEqual([]);
  });

  it('getOverlay returns the project-tier overlay or null', () => {
    const project = getOverlay({ projectRoot: jsTsMinimal, tier: 'project' });
    expect(project).not.toBeNull();
    expect(project!.tier).toBe('project');
    const def = getOverlay({ projectRoot: jsTsMinimal, tier: 'default' });
    expect(def).toBeNull();
  });

  it('getMergedSplicePoints returns the cascaded overlay (S5 full)', async () => {
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    const result = getMergedSplicePoints({ projectRoot: jsTsMinimal });
    // The js-ts-minimal fixture's project overlay has only schemaVersion;
    // the cascade therefore returns an empty merged view.
    expect(result.mergedSplicePoints).toEqual({});
  });

  it('getTrustState (R5 S4) reports approved: false with a current hash and a summary', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'cas-trust-state-home-'));
    try {
      const result = getTrustState({ projectRoot: jsTsMinimal }, { homeDir: tmpHome });
      expect(result.approved).toBe(false);
      expect(typeof result.currentHash).toBe('string');
      expect(result.currentHash.startsWith('sha256:')).toBe(true);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary?.additionalChecksCount).toBe('number');
      expect(result.summary?.perStackOverridesCount).toBe(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('getTrustDiff returns the deferred stub shape and logs a warning', () => {
    const { logger, entries } = makeSpyLogger();
    const result = getTrustDiff({ projectRoot: jsTsMinimal }, { logger });
    expect(result).toEqual({ diff: [], reason: 'trust-not-yet-implemented' });
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].meta).toEqual({ tool: 'getTrustDiff' });
  });

  it('getModuleState returns null (M1 no-op)', () => {
    const result = getModuleState({ projectRoot: jsTsMinimal, name: 'anything' });
    expect(result).toBeNull();
  });

  it('listModules returns an empty list (M1 no-op)', () => {
    const result = listModules({ projectRoot: jsTsMinimal });
    expect(result.modules).toEqual([]);
  });

  it('getStackResolution returns the path + tier for the resolved stack', () => {
    const result = getStackResolution({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.tier).toBe('builtin');
    expect(result.path.endsWith(path.join('stacks', 'web-node.md'))).toBe(true);
  });
});

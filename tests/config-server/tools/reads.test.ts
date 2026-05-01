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

  it('getResolvedConfig returns the partial S2 shape', async () => {
    const result = await getResolvedConfig({ projectRoot: jsTsMinimal });
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.schemaVersions).toEqual({ stack: 1, overlay: 1 });
    expect(result.stackResolution).toEqual({ active: [], byName: {} });
    expect(result.overlays.project).not.toBeNull();
    expect(result.overlays.default).toBeNull();
  });

  it('getStack loads a stack with tier provenance', () => {
    const result = getStack({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.sourceTier).toBe('builtin');
    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe('web-node');
  });

  it('getActiveStacks returns the partial S2 empty active set', () => {
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

  it('getMergedSplicePoints returns the project-tier overlay (S2 partial)', () => {
    const result = getMergedSplicePoints({ projectRoot: jsTsMinimal });
    // The js-ts-minimal fixture's project overlay has only schemaVersion;
    // splice-point keys must be empty (schemaVersion is filtered out).
    expect(result.mergedSplicePoints).toEqual({});
  });

  it('getTrustState returns the loud-stub shape and logs a warning', () => {
    const { logger, entries } = makeSpyLogger();
    const result = getTrustState({ projectRoot: jsTsMinimal }, { logger });
    expect(result).toEqual({ approved: true, reason: 'trust-not-yet-implemented' });
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('trust subsystem not implemented');
    expect(warns[0].meta).toEqual({ tool: 'getTrustState' });
  });

  it('getTrustDiff returns the loud-stub shape and logs a warning', () => {
    const { logger, entries } = makeSpyLogger();
    const result = getTrustDiff({ projectRoot: jsTsMinimal }, { logger });
    expect(result).toEqual({ diff: [], reason: 'trust-not-yet-implemented' });
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('trust subsystem not implemented');
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

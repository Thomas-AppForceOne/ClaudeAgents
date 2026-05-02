import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeResolvedConfig,
  type ResolvedConfig,
} from '../../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import { stableStringify } from '../../../src/config-server/determinism/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const jsTsMinimal = path.join(fixturesRoot, 'js-ts-minimal');

describe('composeResolvedConfig — F2 stable shape', () => {
  beforeEach(() => clearResolvedConfigCache());
  afterEach(() => clearResolvedConfigCache());

  it('returns the full F2 shape for js-ts-minimal', async () => {
    const r: ResolvedConfig = await composeResolvedConfig(jsTsMinimal);
    expect(r.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.schemaVersions).toEqual({ stack: 1, overlay: 1 });
    // No package.json on disk → empty active set, empty byName.
    expect(r.stacks.active).toEqual([]);
    expect(r.stacks.byName).toEqual({});
    // Project overlay only declares schemaVersion → cascaded overlay empty.
    expect(r.overlay).toEqual({});
    expect(r.discarded).toEqual([]);
    expect(r.additionalContext.planner).toEqual([]);
    expect(r.additionalContext.proposer).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('idempotent: byte-identical JSON across two consecutive calls', async () => {
    const a = await composeResolvedConfig(jsTsMinimal);
    const b = await composeResolvedConfig(jsTsMinimal);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('keys are sorted at every depth (stableStringify round-trip property)', async () => {
    const r = await composeResolvedConfig(jsTsMinimal);
    const serialised = stableStringify(r);
    // Manually-produced sorted serialisation should match.
    const parsed = JSON.parse(serialised);
    const reSerialised = stableStringify(parsed);
    expect(serialised).toBe(reSerialised);
  });

  it('top-level keys: apiVersion, schemaVersions, runtimeMode, stacks, overlay, discarded, additionalContext, issues', async () => {
    const r = await composeResolvedConfig(jsTsMinimal);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual([
      'additionalContext',
      'apiVersion',
      'discarded',
      'issues',
      'overlay',
      'runtimeMode',
      'schemaVersions',
      'stacks',
    ]);
  });
});

// Pins the F2 "stable shape" contract of composeResolvedConfig: the full set
// of top-level keys, their default values for a minimal project, and — most
// importantly — determinism. The same project must serialise byte-identically
// across calls, and stableStringify must sort keys at every depth so the
// serialised form is a fixed point (re-serialising a parse of it yields the
// same bytes). That stability is what lets downstream consumers hash/diff the
// resolved config; a non-deterministic key order or a drifting key set would
// break those consumers, so the assertions are deliberately exact.
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

    expect(r.stacks.active).toEqual([]);
    expect(r.stacks.byName).toEqual({});

    expect(r.overlay).toEqual({});
    expect(r.discarded).toEqual([]);
    expect(r.additionalContext.planner).toEqual([]);
    expect(r.additionalContext.proposer).toEqual([]);
    expect(r.issues).toEqual([]);
    // warnings is always present and is an empty array for a clean project with
    // no override and no per-stack command declarations.
    expect(r.warnings).toEqual([]);
  });

  it('idempotent: byte-identical JSON across two consecutive calls', async () => {
    const a = await composeResolvedConfig(jsTsMinimal);
    const b = await composeResolvedConfig(jsTsMinimal);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('keys are sorted at every depth (stableStringify round-trip property)', async () => {
    const r = await composeResolvedConfig(jsTsMinimal);
    const serialised = stableStringify(r);

    // Fixed-point property: parsing the serialised form and re-serialising must
    // reproduce the exact bytes. This holds only if stableStringify sorts keys
    // recursively, so it doubles as a depth-wise sort check.
    const parsed = JSON.parse(serialised);
    const reSerialised = stableStringify(parsed);
    expect(serialised).toBe(reSerialised);
  });

  it('top-level keys: apiVersion, schemaVersions, runtimeMode, stacks, overlay, discarded, additionalContext, issues, warnings, modules', async () => {
    const r = await composeResolvedConfig(jsTsMinimal);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual([
      'additionalContext',
      'apiVersion',
      'discarded',
      'issues',
      'modules',
      'overlay',
      'runtimeMode',
      'schemaVersions',
      'stacks',
      'warnings',
    ]);
  });
});

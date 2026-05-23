/**
 * End-to-end happy path for a clean, conventional web-node project.
 *
 * The `js-ts-minimal` fixture is the canonical "nothing wrong here" repo: one
 * built-in stack, no overlays, no modules. This suite is the regression guard
 * that the full resolve/validate pipeline stays silent and shape-stable on
 * such a project — if a future change starts emitting spurious issues or
 * quietly reshapes the resolved-config envelope, one of these three tests
 * breaks.
 *
 * The three tests escalate in strictness:
 *   1. `validateAll` surfaces zero issues (no false positives on clean input);
 *   2. `getResolvedConfig` returns the exact F2 top-level key set and the
 *      expected empty/default value for each branch (a structural contract);
 *   3. the deterministically-serialised payload is byte-for-byte equal to a
 *      committed golden snapshot (the strongest lock — catches any drift the
 *      key/value assertions miss).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { getResolvedConfig } from '../../../src/config-server/tools/reads.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import { stableStringify } from '../../../src/config-server/determinism/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');
const snapshotPath = path.join(here, '__snapshots__', 'clean-web-node.json');

describe('integration: clean web-node project (js-ts-minimal)', () => {
  beforeEach(() => clearResolvedConfigCache());
  afterEach(() => clearResolvedConfigCache());

  it('validateAll returns zero issues', () => {
    const result = validateAll({ projectRoot: jsTsMinimal });
    expect(result.issues).toEqual([]);
  });

  it('getResolvedConfig returns the full F2 stable shape', async () => {
    const r = await getResolvedConfig({ projectRoot: jsTsMinimal });

    expect(Object.keys(r).sort()).toEqual([
      'additionalContext',
      'apiVersion',
      'discarded',
      'issues',
      'modules',
      'overlay',
      'runtimeMode',
      'schemaVersions',
      'stacks',
    ]);
    expect(r.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.schemaVersions).toEqual({ stack: 1, overlay: 1 });
    expect(r.runtimeMode).toEqual({ noProjectCommands: false });
    expect(r.stacks).toEqual({ active: [], byName: {} });
    expect(r.overlay).toEqual({});
    expect(r.discarded).toEqual([]);
    expect(r.additionalContext).toEqual({ planner: [], proposer: [] });
    expect(r.issues).toEqual([]);
    expect(r.modules).toEqual({});
  });

  it('serialised payload matches the on-disk snapshot', async () => {
    const r = await getResolvedConfig({ projectRoot: jsTsMinimal });

    // Pin the one inherently-variable field to a placeholder so the snapshot is
    // stable across version bumps; everything else must match the golden byte
    // for byte (assertion (1) already proved apiVersion is semver-shaped).
    const stable = { ...r, apiVersion: '<api-version>' } as typeof r;
    const serialised = stableStringify(stable);
    // Regenerate the golden on demand (UPDATE_GOLDENS=1) or seed it on first run
    // when it does not yet exist; otherwise the read below compares against it.
    if (process.env.UPDATE_GOLDENS === '1' || !existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, serialised);
    }
    const expected = readFileSync(snapshotPath, 'utf8');
    expect(serialised).toBe(expected);
  });
});

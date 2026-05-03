/**
 * R1 sprint 7 integration test — F2 acceptance scenario for a clean
 * web-node project (the `js-ts-minimal` fixture).
 *
 * Asserts:
 *   1. `validateAll` returns zero issues.
 *   2. `getResolvedConfig` returns the full F2 stable shape with every
 *      top-level field present.
 *   3. The serialised payload matches the snapshot at
 *      `__snapshots__/clean-web-node.json`. Snapshot drift is intentional
 *      and surfaces as a test failure so future refactors notice schema
 *      changes against this clean fixture.
 *
 * The fixture has no `package.json` on disk, so detection produces an
 * empty active set — which is the F2 contract for a project with no
 * detected stack. We assert that explicitly.
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
    // Top-level keys:
    expect(Object.keys(r).sort()).toEqual([
      'additionalContext',
      'apiVersion',
      'discarded',
      'issues',
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
  });

  it('serialised payload matches the on-disk snapshot', async () => {
    const r = await getResolvedConfig({ projectRoot: jsTsMinimal });
    // Replace the only non-deterministic field (apiVersion) with a token
    // so the snapshot is stable across version bumps.
    const stable = { ...r, apiVersion: '<api-version>' } as typeof r;
    const serialised = stableStringify(stable);
    if (process.env.UPDATE_GOLDENS === '1' || !existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, serialised);
    }
    const expected = readFileSync(snapshotPath, 'utf8');
    expect(serialised).toBe(expected);
  });
});


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

    const stable = { ...r, apiVersion: '<api-version>' } as typeof r;
    const serialised = stableStringify(stable);
    if (process.env.UPDATE_GOLDENS === '1' || !existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, serialised);
    }
    const expected = readFileSync(snapshotPath, 'utf8');
    expect(serialised).toBe(expected);
  });
});

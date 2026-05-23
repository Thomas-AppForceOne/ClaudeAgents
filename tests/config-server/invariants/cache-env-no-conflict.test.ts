// Guards the `cacheEnv.no_conflict` invariant: when two active stack files
// each declare a cache-environment variable of the same name, they must agree
// on its `valueTemplate`. Two stacks pinning e.g. NODE_VERSION to "20" and
// "22" would produce a non-deterministic build cache key, so this is an
// `error` (fatal), not a warning.
//
// The conflict is only detectable once each stack row carries parsed YAML, so
// `hydrateSnapshot` re-reads and re-parses every stack file into `row.data`
// before the check runs — phase-1 alone records the file paths but not their
// bodies. Checked both at the unit entrypoint and end-to-end via `validateAll`.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkCacheEnvNoConflict } from '../../../src/config-server/invariants/cache-env-no-conflict.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const conflictFixture = path.join(fixturesRoot, 'invariant-cache-env-conflict');

// Phase-1 records stack-file paths but leaves their bodies unparsed; this
// invariant inspects YAML, so each row's `data`/`prose` must be filled in
// from disk before the check can see any cacheEnv declarations.
function hydrateSnapshot(projectRoot: string) {
  const snapshot = _runPhase1ForTests(projectRoot);
  for (const row of snapshot.stackFiles.values()) {
    try {
      const text = readFileSync(row.path, 'utf8');
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // ignore
    }
  }
  return snapshot;
}

describe('cacheEnv.no_conflict invariant', () => {
  it('returns no issues for js-ts-minimal (no cacheEnv declarations)', () => {
    const snapshot = hydrateSnapshot(cleanFixture);
    expect(checkCacheEnvNoConflict(snapshot)).toEqual([]);
  });

  it('fires InvariantViolation when two stacks declare conflicting cacheEnv values', () => {
    const snapshot = hydrateSnapshot(conflictFixture);
    const issues = checkCacheEnvNoConflict(snapshot);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/cacheEnv');
    // The message must name the var and quote both conflicting templates so the
    // author can see exactly which two values disagree, plus the failing reason.
    expect(issue.message).toContain('NODE_VERSION');
    expect(issue.message).toContain('"20"');
    expect(issue.message).toContain('"22"');
    expect(issue.message).toContain('different valueTemplate');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: conflictFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/cacheEnv' &&
        i.message.includes('NODE_VERSION'),
    );
    expect(fired).toBeTruthy();
  });
});

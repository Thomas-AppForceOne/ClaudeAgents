import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkStackTierApiVersion } from '../../../src/config-server/invariants/stack-tier-api-version.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const badVersionFixture = path.join(fixturesRoot, 'invariant-stack-tier-api-version');

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

describe('stack.tier_apiVersion invariant', () => {
  it('returns no issues for the clean js-ts-minimal fixture', () => {
    const snapshot = hydrateSnapshot(cleanFixture);
    expect(checkStackTierApiVersion(snapshot)).toEqual([]);
  });

  it('fires when a stack file declares schemaVersion=999', () => {
    const snapshot = hydrateSnapshot(badVersionFixture);
    const issues = checkStackTierApiVersion(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/schemaVersion');
    expect(issue.path).toContain('web-node.md');
    expect(issue.message).toContain('999');
    expect(issue.message).toContain('schemaVersion=1');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: badVersionFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/schemaVersion' &&
        (i.path ?? '').includes('web-node.md') &&
        i.message.includes('999'),
    );
    expect(fired).toBeTruthy();
  });
});

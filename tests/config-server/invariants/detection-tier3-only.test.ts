import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkDetectionTier3Only } from '../../../src/config-server/invariants/detection-tier3-only.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const badTierFixture = path.join(fixturesRoot, 'invariant-detection-on-tier1or2');

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

describe('detection.tier3_only invariant', () => {
  it('returns no issues for js-ts-minimal (only built-in stack has detection)', () => {
    const snapshot = hydrateSnapshot(cleanFixture);
    expect(checkDetectionTier3Only(snapshot)).toEqual([]);
  });

  it('fires when a project-tier stack file declares a detection block', () => {
    const snapshot = hydrateSnapshot(badTierFixture);
    const issues = checkDetectionTier3Only(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/detection');
    expect(issue.path).toContain('.claude/gan/stacks/web-node.md');
    expect(issue.message).toContain('project-tier');
    expect(issue.message).toContain('only allowed in built-in');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: badTierFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/detection' &&
        (i.path ?? '').includes('.claude/gan/stacks/'),
    );
    expect(fired).toBeTruthy();
  });
});

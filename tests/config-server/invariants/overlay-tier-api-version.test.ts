import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkOverlayTierApiVersion } from '../../../src/config-server/invariants/overlay-tier-api-version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const badVersionFixture = path.join(fixturesRoot, 'invariant-overlay-tier-api-version');

describe('overlay.tier_apiVersion invariant', () => {
  it('returns no issues for the clean js-ts-minimal fixture', () => {
    const snapshot = _runPhase1ForTests(cleanFixture);
    expect(checkOverlayTierApiVersion(snapshot)).toEqual([]);
  });

  it('fires when an overlay declares schemaVersion=999', () => {
    const snapshot = _runPhase1ForTests(badVersionFixture);
    const issues = checkOverlayTierApiVersion(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/schemaVersion');
    expect(issue.path).toContain('project.md');
    expect(issue.message).toContain('999');
    expect(issue.message).toContain('schemaVersion=1');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: badVersionFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/schemaVersion' &&
        i.message.includes('999'),
    );
    expect(fired).toBeTruthy();
  });
});

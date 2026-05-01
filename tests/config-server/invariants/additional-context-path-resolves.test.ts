import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkAdditionalContextPathResolves } from '../../../src/config-server/invariants/additional-context-path-resolves.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const missingPathFixture = path.join(fixturesRoot, 'invariant-additional-context-missing');

describe('additionalContext.path_resolves invariant', () => {
  it('returns no issues for the clean js-ts-minimal fixture', () => {
    const snapshot = _runPhase1ForTests(cleanFixture);
    expect(checkAdditionalContextPathResolves(snapshot)).toEqual([]);
  });

  it('fires a warning when proposer.additionalContext lists a missing file', () => {
    const snapshot = _runPhase1ForTests(missingPathFixture);
    const issues = checkAdditionalContextPathResolves(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('warning');
    expect(issue.field).toBe('/proposer/additionalContext');
    expect(issue.path).toContain('project.md');
    expect(issue.message).toContain('docs/missing.md');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: missingPathFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        i.severity === 'warning' &&
        (i.field ?? '') === '/proposer/additionalContext',
    );
    expect(fired).toBeTruthy();
    expect(fired!.message).toContain('docs/missing.md');
  });
});

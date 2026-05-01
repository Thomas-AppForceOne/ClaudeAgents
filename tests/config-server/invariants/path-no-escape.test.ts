import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkPathNoEscape } from '../../../src/config-server/invariants/path-no-escape.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const escapeFixture = path.join(fixturesRoot, 'invariant-path-escape');

describe('path.no_escape invariant', () => {
  it('returns no issues for the clean js-ts-minimal fixture', () => {
    const snapshot = _runPhase1ForTests(cleanFixture);
    expect(checkPathNoEscape(snapshot)).toEqual([]);
  });

  it('fires when proposer.additionalContext lists a path that escapes the project root', () => {
    const snapshot = _runPhase1ForTests(escapeFixture);
    const issues = checkPathNoEscape(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/proposer/additionalContext');
    expect(issue.path).toContain('project.md');
    expect(issue.message).toContain('../../etc/passwd');
    expect(issue.message).toContain('outside the project root');
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: escapeFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        i.severity === 'error' &&
        (i.field ?? '') === '/proposer/additionalContext' &&
        i.message.includes('outside the project root'),
    );
    expect(fired).toBeTruthy();
  });
});

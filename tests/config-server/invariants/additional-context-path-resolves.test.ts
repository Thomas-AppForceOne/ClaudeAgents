// Guards the `additionalContext.path_resolves` invariant: a context file
// listed under proposer/planner `additionalContext` must actually exist on
// disk. The contract is a non-fatal warning (not an error) — a dangling
// context reference should nag the author without halting the run, since the
// missing file is a documentation gap rather than a security or correctness
// breach (path *escape* is a separate, harder invariant).
//
// Each invariant here is checked at two layers: the unit entrypoint
// (`checkAdditionalContextPathResolves` against a hand-built phase-1 snapshot)
// AND end-to-end through `validateAll`. The pair exists to catch a regression
// where the invariant works in isolation but is never wired into the
// aggregate validation pass (or vice versa).
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
    // severity is `warning`, not `error` — the dangling reference must not halt
    // the run, only nag. This is the load-bearing distinction of this invariant.
    expect(issue.severity).toBe('warning');
    // `field` points at the splice-point that owns the bad value; `path` names
    // the source file it came from (the overlay), not the missing target.
    expect(issue.field).toBe('/proposer/additionalContext');
    expect(issue.path).toContain('project.md');
    // The message names the offending target so the author can fix it directly.
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

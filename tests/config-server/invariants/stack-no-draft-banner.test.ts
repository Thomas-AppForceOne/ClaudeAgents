// Guards the `stack.no_draft_banner` invariant: when the scaffolder generates
// a new stack file it stamps a DRAFT banner into the prose to mark it as
// not-yet-reviewed. Shipping a stack that still carries that banner means the
// author never finished it, so the invariant fails with an `error` until the
// banner is removed. The check inspects `/prose` (the body below the YAML
// front-matter), not the structured data.
//
// The expected banner text is imported as the real `DRAFT_BANNER` constant
// rather than hard-coded, so the test stays correct if the banner wording is
// ever changed at its single source. `hydrateSnapshot` parses each stack file
// so `row.prose` is populated for the check. Verified at the unit entrypoint
// and end-to-end via `validateAll`.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkStackNoDraftBanner } from '../../../src/config-server/invariants/stack-no-draft-banner.js';
import { DRAFT_BANNER } from '../../../src/config-server/scaffold-banner.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const draftFixture = path.join(fixturesRoot, 'invariant-stack-draft-banner');

// The banner lives in the stack body/prose, which phase-1 leaves unparsed;
// populate each row's `data`/`prose` from disk so the check can inspect prose.
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

describe('stack.no_draft_banner invariant', () => {
  it('returns no issues for js-ts-minimal (no banner)', () => {
    const snapshot = hydrateSnapshot(cleanFixture);
    expect(checkStackNoDraftBanner(snapshot)).toEqual([]);
  });

  it('fires when a stack file still carries the DRAFT scaffold banner', () => {
    const snapshot = hydrateSnapshot(draftFixture);
    const issues = checkStackNoDraftBanner(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    // The violation is located at `/prose`, not a structured field. Asserting
    // against the imported DRAFT_BANNER (not a literal) keeps this test in lock-
    // step with the scaffolder if the banner text ever changes.
    expect(issue.field).toBe('/prose');
    expect(issue.path).toContain('web-node.md');
    expect(issue.message).toContain('DRAFT');
    expect(issue.message).toContain(DRAFT_BANNER);
  });

  it('surfaces through validateAll end-to-end', () => {
    const result = validateAll({ projectRoot: draftFixture });
    const fired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/prose' &&
        i.message.includes('DRAFT'),
    );
    expect(fired).toBeTruthy();
  });
});

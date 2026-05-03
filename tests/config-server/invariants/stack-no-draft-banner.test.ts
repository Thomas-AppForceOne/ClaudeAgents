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

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests } from '../../../src/config-server/tools/validate.js';
import {
  buildShadowedPairsWithMessage,
  checkPairsWithConsistency,
} from '../../../src/config-server/invariants/pairs-with-consistency.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const shadowedFixture = path.join(fixturesRoot, 'invariant-pairs-with-shadowed');
const c5SpecPath = path.join(repoRoot, 'specifications', 'C5-stack-file-resolution.md');

/**
 * Hydrate snapshot stack rows with their parsed data — phase 1 only loads
 * paths, phase 2 fills in `data`/`prose`. The invariants need `data`. We
 * read the file, parse the YAML block, and patch the row directly.
 */
async function hydrateSnapshot(projectRoot: string) {
  const snapshot = _runPhase1ForTests(projectRoot);
  const { parseYamlBlock } =
    await import('../../../src/config-server/storage/yaml-block-parser.js');
  for (const row of snapshot.stackFiles.values()) {
    try {
      const text = readFileSync(row.path, 'utf8');
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // Leave row.data unset — invariant should treat as no-op.
    }
  }
  return snapshot;
}

describe('pairsWith.consistency invariant', () => {
  it('returns no issues against the clean js-ts-minimal fixture', async () => {
    const snapshot = await hydrateSnapshot(cleanFixture);
    const issues = checkPairsWithConsistency(snapshot);
    expect(issues).toEqual([]);
  });

  it('fires the C5 verbatim error when a project tier shadows a paired built-in', async () => {
    const snapshot = await hydrateSnapshot(shadowedFixture);
    const issues = checkPairsWithConsistency(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('InvariantViolation');
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/pairsWith');
    expect(issue.path).toContain('.claude/gan/stacks/docker.md');
    // Byte-identical match with the C5 spec wording (template substituted
    // with stackName='docker', the example used in C5 itself).
    const expected = buildShadowedPairsWithMessage('docker');
    expect(issue.message).toBe(expected);
  });

  it("matches the verbatim string quoted in C5's spec text", () => {
    // Defence in depth against drift: read C5's spec and confirm our
    // template reproduces the exact prose. C5 quotes the wording inside
    // a markdown blockquote line (`> \`pairs-with.consistency: ...\``);
    // strip the leading `> ` and the surrounding backticks, then assert
    // byte-equality with the generated message.
    const c5Text = readFileSync(c5SpecPath, 'utf8');
    const generated = buildShadowedPairsWithMessage('docker');
    const lines = c5Text.split(/\r?\n/);
    const quoteLine = lines.find(
      (l) => l.startsWith('> ') && l.includes('pairs-with.consistency:'),
    );
    expect(quoteLine).toBeTruthy();
    // The quote line is `> ` + `\`...\``. Strip both wrappers.
    const stripped = quoteLine!.replace(/^>\s+/, '').replace(/^`/, '').replace(/`$/, '');
    expect(stripped).toBe(generated);
  });

  it('runs through validateAll when the fixture is loaded end-to-end', () => {
    const result = validateAll({ projectRoot: shadowedFixture });
    const fired = result.issues.find(
      (i) => i.code === 'InvariantViolation' && (i.field ?? '') === '/pairsWith',
    );
    expect(fired).toBeTruthy();
    expect(fired!.message).toBe(buildShadowedPairsWithMessage('docker'));
  });
});

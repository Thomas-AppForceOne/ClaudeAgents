import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests } from '../../../src/config-server/tools/validate.js';
import {
  SHADOWED_DEFAULT_REMEDIATION,
  buildShadowedPairsWithMessage,
  checkPairsWithConsistency,
} from '../../../src/config-server/invariants/pairs-with-consistency.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const moduleFixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'modules');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const shadowedFixture = path.join(fixturesRoot, 'invariant-pairs-with-shadowed');
const c5SpecPath = path.join(repoRoot, 'specifications', 'C5-stack-file-resolution.md');

const softOkFixture = path.join(fixturesRoot, 'pairs-with-soft-ok');
const disagreeFixture = path.join(fixturesRoot, 'pairs-with-disagree');
const shadowedDefaultFixture = path.join(fixturesRoot, 'pairs-with-shadowed-default');
const missingModuleFixture = path.join(
  fixturesRoot,
  'pairs-with-stack-references-missing-module',
);

/**
 * Hydrate snapshot stack rows with their parsed data — phase 1 only loads
 * paths, phase 2 fills in `data`/`prose`. The invariants need `data`. We
 * read the file, parse the YAML block, and patch the row directly.
 */
async function hydrateSnapshot(
  projectRoot: string,
  ctx: { modulesRoot?: string } = {},
) {
  const snapshot = _runPhase1ForTests(projectRoot, ctx);
  const { parseYamlBlock } = await import(
    '../../../src/config-server/storage/yaml-block-parser.js'
  );
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

  // -------- AC9 four-case coverage --------------------------------------

  it('case 1 (soft-OK): module declares pairsWith but the stack omits it — no error', async () => {
    // Modules root contains a single fixture module declaring
    // `pairsWith: paired-soft-ok`. The fixture stack's project tier
    // file omits `pairsWith`. Per the soft-OK rule, no error fires.
    const moduleScratch = path.join(moduleFixturesRoot);
    // Stage a module manifest that pairs with paired-soft-ok via
    // direct file inspection — no need to copy; the fixture itself
    // is hermetic when injected.
    const snapshot = await hydrateSnapshot(softOkFixture);
    // Inject the module row manually since the fixture under
    // `tests/fixtures/modules/` isn't a paired module yet.
    snapshot.modules.push({
      name: 'paired-soft-ok-module',
      manifestPath: '/virtual/paired-soft-ok-module/manifest.json',
      pairsWith: 'paired-soft-ok',
    });
    const issues = checkPairsWithConsistency(snapshot);
    expect(issues).toEqual([]);
    void moduleScratch;
  });

  it('case 2 (disagree): both sides declare pairsWith and they differ — hard error', async () => {
    const snapshot = await hydrateSnapshot(disagreeFixture);
    snapshot.modules.push({
      name: 'paired-disagree',
      manifestPath: '/virtual/paired-disagree/manifest.json',
      pairsWith: 'paired-disagree',
    });
    const issues = checkPairsWithConsistency(snapshot);
    const disagreeIssue = issues.find((i) => i.message.includes('paired-disagree'));
    expect(disagreeIssue).toBeTruthy();
    expect(disagreeIssue!.code).toBe('InvariantViolation');
    expect(disagreeIssue!.message).toContain('some-other-module');
  });

  it('case 3 (shadowed-default): project tier shadows built-in but omits pairsWith — C5 verbatim error', async () => {
    const snapshot = await hydrateSnapshot(shadowedDefaultFixture);
    const issues = checkPairsWithConsistency(snapshot);
    const fired = issues.find((i) => (i.field ?? '') === '/pairsWith');
    expect(fired).toBeTruthy();
    expect(fired!.code).toBe('InvariantViolation');
    expect(fired!.message).toBe(buildShadowedPairsWithMessage('paired-shadowed'));
  });

  it('case 3 (shadowed-default): test imports the SHADOWED_DEFAULT_REMEDIATION constant', () => {
    // AC10: assert the constant is exported and the substituted output
    // round-trips correctly. The test body itself MUST NOT contain the
    // multiline literal — the only reference is the imported constant.
    expect(typeof SHADOWED_DEFAULT_REMEDIATION).toBe('string');
    expect(SHADOWED_DEFAULT_REMEDIATION).toContain('<stackName>');
    const substituted = SHADOWED_DEFAULT_REMEDIATION.split('<stackName>').join('xyz');
    expect(buildShadowedPairsWithMessage('xyz')).toBe(substituted);
  });

  it('case 4 (stack references missing module): hard error', async () => {
    const snapshot = await hydrateSnapshot(missingModuleFixture);
    // No modules registered. The fixture stack's `pairsWith: nonexistent-module`
    // must fire the missing-module branch.
    const issues = checkPairsWithConsistency(snapshot);
    const fired = issues.find((i) => i.message.includes('nonexistent-module'));
    expect(fired).toBeTruthy();
    expect(fired!.code).toBe('InvariantViolation');
  });

  it('case 3 (shadowed-default): the fixture creates NO new files at the actual repo-root stacks/', () => {
    // AC11 guard. The fixture lives entirely under
    // tests/fixtures/stacks/pairs-with-shadowed-default/. We assert
    // the fixture's built-in copy is at <fixtureRoot>/stacks/, not
    // at <repoRoot>/stacks/.
    const expected = path.join(
      shadowedDefaultFixture,
      'stacks',
      'paired-shadowed.md',
    );
    const text = readFileSync(expected, 'utf8');
    expect(text).toContain('paired-shadowed (fixture-internal built-in)');
    // The repo-root stacks/ must not have a paired-shadowed.md.
    let realRepoCopy: string | null = null;
    try {
      realRepoCopy = readFileSync(
        path.join(repoRoot, 'stacks', 'paired-shadowed.md'),
        'utf8',
      );
    } catch {
      realRepoCopy = null;
    }
    expect(realRepoCopy).toBeNull();
  });
});

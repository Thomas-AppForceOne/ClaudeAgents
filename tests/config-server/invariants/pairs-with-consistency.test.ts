// Guards the `pairsWith.consistency` invariant from spec C5: a `pairsWith`
// declaration links a stack to a module (or vice versa), and the two sides
// must not contradict each other. The invariant covers four distinct shapes:
//   - soft-OK   : a module declares pairsWith but the stack stays silent — fine;
//   - disagree  : both sides declare pairsWith and name different partners — error;
//   - shadowed-default: a project-tier stack shadows a paired built-in but drops
//                 the pairsWith — error, with the C5 verbatim remediation;
//   - missing-module: a stack pairsWith a module that does not exist — error.
//
// Two facts make this suite worth its complexity:
//  1. The shadowed-stack error string is QUOTED VERBATIM in the C5 spec, so one
//     test re-reads C5.md and asserts byte-equality with the generated message
//     (`buildShadowedPairsWithMessage`). If the wording drifts from the spec,
//     that test fails — the message is a contract, not free text. Do not edit
//     the quoted spec line; the test reads it as data.
//  2. The shadowed-default fixture deliberately uses a *fixture-internal*
//     built-in under its own `stacks/`, never the real repo-root `stacks/`. A
//     dedicated test asserts no `paired-shadowed.md` leaked into the actual
//     repo, guarding against a fixture that pollutes the working tree.
//
// `hydrateSnapshot` is async because it dynamically imports the YAML parser and
// fills each stack row's parsed body, which the invariant inspects.
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

    // Exact-match (not `toContain`): the wording is a contract quoted in C5, so
    // any drift must fail. The next test pins it against the spec source itself.
    const expected = buildShadowedPairsWithMessage('docker');
    expect(issue.message).toBe(expected);
  });

  it("matches the verbatim string quoted in C5's spec text", () => {

    // Read C5.md as DATA and recover the one blockquote line that quotes this
    // invariant's message, then strip the `> ` prefix and surrounding backticks
    // so it can be compared byte-for-byte against the generated string. This is
    // the test that makes the message a spec-pinned contract.
    const c5Text = readFileSync(c5SpecPath, 'utf8');
    const generated = buildShadowedPairsWithMessage('docker');
    const lines = c5Text.split(/\r?\n/);
    const quoteLine = lines.find(
      (l) => l.startsWith('> ') && l.includes('pairs-with.consistency:'),
    );
    expect(quoteLine).toBeTruthy();

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

  it('case 1 (soft-OK): module declares pairsWith but the stack omits it — no error', async () => {

    const moduleScratch = path.join(moduleFixturesRoot);

    const snapshot = await hydrateSnapshot(softOkFixture);

    // The module side is injected directly into the snapshot rather than loaded
    // from a real manifest (the manifestPath is a /virtual sentinel) so the test
    // controls exactly one pairing without standing up an on-disk module tree.
    snapshot.modules.push({
      name: 'paired-soft-ok-module',
      manifestPath: '/virtual/paired-soft-ok-module/manifest.json',
      pairsWith: 'paired-soft-ok',
    });
    const issues = checkPairsWithConsistency(snapshot);
    expect(issues).toEqual([]);
    // `moduleScratch` is computed for parity with the other cases but unused
    // here; voided so it does not trip no-unused-vars.
    void moduleScratch;
  });

  it('case 2 (disagree): both sides declare pairsWith and they differ — hard error', async () => {
    const snapshot = await hydrateSnapshot(disagreeFixture);
    // Inject a module whose pairsWith ('paired-disagree') contradicts the value
    // the fixture's stack declares ('some-other-module'); the invariant must
    // flag the mismatch and name the other partner in the message.
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

    // Pins the relationship between the exported template and the builder: the
    // message is exactly the template with `<stackName>` substituted. Proving it
    // by substitution (rather than re-typing the string) keeps the two in sync.
    expect(typeof SHADOWED_DEFAULT_REMEDIATION).toBe('string');
    expect(SHADOWED_DEFAULT_REMEDIATION).toContain('<stackName>');
    const substituted = SHADOWED_DEFAULT_REMEDIATION.split('<stackName>').join('xyz');
    expect(buildShadowedPairsWithMessage('xyz')).toBe(substituted);
  });

  it('case 4 (stack references missing module): hard error', async () => {
    const snapshot = await hydrateSnapshot(missingModuleFixture);

    const issues = checkPairsWithConsistency(snapshot);
    const fired = issues.find((i) => i.message.includes('nonexistent-module'));
    expect(fired).toBeTruthy();
    expect(fired!.code).toBe('InvariantViolation');
  });

  it('case 3 (shadowed-default): the fixture creates NO new files at the actual repo-root stacks/', () => {

    // Hygiene guard: the "built-in" this case shadows lives INSIDE the fixture
    // (its body is self-labelled fixture-internal), and the real repo-root
    // stacks/ must stay untouched. A missing repo-root copy is the pass
    // condition, so the read is wrapped in try/catch — ENOENT means clean.
    const expected = path.join(
      shadowedDefaultFixture,
      'stacks',
      'paired-shadowed.md',
    );
    const text = readFileSync(expected, 'utf8');
    expect(text).toContain('paired-shadowed (fixture-internal built-in)');

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

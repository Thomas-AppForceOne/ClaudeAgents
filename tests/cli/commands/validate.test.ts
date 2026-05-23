// End-to-end tests for `gan validate`, spawning the built CLI against curated
// fixtures. They pin the exit-code-by-failure-class contract: 0 + "0 issues
// found." on a clean config; 2 for schema-class failures; 4 for invariant
// violations (e.g. the un-edited DRAFT banner). The human surface is locked to a
// stable per-issue line format (`(error|warning) <Code> <loc>: <msg>`), and the
// `--json` surface is verified to be parseable, to carry the same issues, and to
// be byte-identical across runs (determinism). A final round-trip test scaffolds
// a stack with `gan stacks new` and confirms `validate` then flags its DRAFT
// banner — proving the two commands compose as a user would chain them.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateAll, type Issue } from '../../../src/config-server/tools/validate.js';
import { runGan } from '../helpers/spawn.js';
import { stackFixturePath } from '../helpers/fixtures.js';

// Three fixtures spanning the failure classes: clean (0 issues), schema-only
// violation (exit 2, no invariants), and an invariant violation (DRAFT banner,
// exit 4).
const CLEAN_FIXTURE = stackFixturePath('js-ts-minimal');
const SCHEMA_VIOLATION_FIXTURE = stackFixturePath('cli-validate-schema-violation');
const INVARIANT_FIXTURE = stackFixturePath('invariant-stack-draft-banner');

// The locked human-readable issue-line format every printed issue must match.
const ISSUE_LINE_RE = /^(error|warning) [A-Za-z]+ .+: .+$/;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// A fresh temp project root for the round-trip test, registered for teardown.
function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-validate-'));
  tmpDirs.push(dir);
  return dir;
}

// The trailing summary line ("N issues found.") is the last non-empty line of
// stdout; this extracts it so the summary can be asserted independent of any
// issue lines printed above it.
function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

describe('gan validate — clean fixture', () => {
  it('exits 0 and prints `0 issues found.` as the last non-empty line', async () => {
    const r = await runGan(['validate', '--project-root', CLEAN_FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(lastNonEmptyLine(r.stdout)).toBe('0 issues found.');
  });
});

describe('gan validate — schema-only failure (fixture: cli-validate-schema-violation)', () => {
  it('the fixture itself produces ONLY schema-class issues (no InvariantViolation)', () => {
    // Validate the fixture directly (no CLI spawn) to confirm it is a *pure*
    // schema failure. This guards the exit-2 test below: if an invariant ever
    // crept into this fixture it would change the exit code to 4, so we pin the
    // fixture's failure class at the source.
    const direct = validateAll({ projectRoot: SCHEMA_VIOLATION_FIXTURE });
    expect(direct.issues.length).toBeGreaterThan(0);
    const invariantHits = direct.issues.filter((i: Issue) => i.code === 'InvariantViolation');
    expect(invariantHits.length).toBe(0);
  });

  it('exits 2 and prints at least one issue line', async () => {
    const r = await runGan(['validate', '--project-root', SCHEMA_VIOLATION_FIXTURE]);
    expect(r.exitCode).toBe(2);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);

    const issueLines = lines.filter((l) => ISSUE_LINE_RE.test(l));
    expect(issueLines.length).toBeGreaterThan(0);
  });
});

describe('gan validate — invariant fixture (DRAFT banner)', () => {
  it('exits 4 and stdout contains `DRAFT` and `web-node.md`', async () => {
    const r = await runGan(['validate', '--project-root', INVARIANT_FIXTURE]);
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toContain('DRAFT');
    expect(r.stdout).toContain('web-node.md');
  });

  it('issue lines match the locked format /^(error|warning) [A-Za-z]+ .+: .+$/', async () => {
    const r = await runGan(['validate', '--project-root', INVARIANT_FIXTURE]);
    expect(r.exitCode).toBe(4);
    // Exclude the "N issues" summary line, then require every remaining line to
    // be a well-formed issue line — catching any stray/unformatted output.
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    const issueLines = lines.filter((l) => !/^[0-9]+ issue/.test(l));
    expect(issueLines.length).toBeGreaterThan(0);
    for (const ln of issueLines) {
      expect(ln, `issue line failed regex: ${ln}`).toMatch(ISSUE_LINE_RE);
    }
  });
});

describe('gan validate — --json surface', () => {
  it('emits a parseable JSON document with trailing newline (clean fixture)', async () => {
    const r = await runGan(['validate', '--project-root', CLEAN_FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { issues: Issue[] };
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(parsed.issues.length).toBe(0);
  });

  it('emits a parseable JSON document for the invariant fixture; exit code matches non-JSON', async () => {
    const r = await runGan(['validate', '--project-root', INVARIANT_FIXTURE, '--json']);
    expect(r.exitCode).toBe(4);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { issues: Issue[] };
    expect(parsed.issues.length).toBeGreaterThan(0);
    const draft = parsed.issues.find((i) => i.message.includes('DRAFT'));
    expect(draft).toBeTruthy();
    expect(draft?.code).toBe('InvariantViolation');
  });

  it('JSON output is byte-identical across runs (determinism)', async () => {
    const a = await runGan(['validate', '--project-root', INVARIANT_FIXTURE, '--json']);
    const b = await runGan(['validate', '--project-root', INVARIANT_FIXTURE, '--json']);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe('gan validate — end-to-end round-trip with `gan stacks new`', () => {
  it('scaffold a stack into a tmp project, then validate exits 4 citing DRAFT + the file basename', async () => {
    const proj = makeTmpProject();

    // Seed a minimal valid project overlay so the temp project is a recognised
    // gan project before scaffolding into it — the round-trip then exercises
    // the real `stacks new` → `validate` chain rather than an empty dir.
    const overlayDir = path.join(proj, '.claude', 'gan');
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(
      path.join(overlayDir, 'project.md'),
      '---\nschemaVersion: 1\n---\n\n# project overlay (round-trip fixture)\n',
      'utf8',
    );

    const newR = await runGan(['stacks', 'new', 'web-node', '--project-root', proj]);
    expect(newR.exitCode, `stacks new failed: ${newR.stderr}`).toBe(0);

    const validateR = await runGan(['validate', '--project-root', proj]);
    expect(validateR.exitCode).toBe(4);
    expect(validateR.stdout).toContain('DRAFT');
    expect(validateR.stdout).toContain('web-node.md');
  });
});

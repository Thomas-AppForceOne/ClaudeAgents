/**
 * R3 sprint 4 — `gan validate` spawn-based tests.
 *
 * Covers contract criteria AC13-AC21:
 *   - clean fixture exits 0 with summary `0 issues found.`
 *   - schema-only fixture exits 2 with at least one issue line
 *   - invariant-bannered fixture exits 4 with `DRAFT` and `web-node.md`
 *     present in stdout
 *   - issue-line format matches the locked regex (AC18)
 *   - `--json` emits parseable JSON with a trailing newline (AC19)
 *   - end-to-end round-trip: scaffold a stack into a tmp dir, validate
 *     the dir → exit 4 citing `DRAFT` and the file basename (AC21)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  validateAll,
  type Issue,
} from '../../../src/config-server/tools/validate.js';
import { runGan } from '../helpers/spawn.js';
import { stackFixturePath } from '../helpers/fixtures.js';

const CLEAN_FIXTURE = stackFixturePath('js-ts-minimal');
const SCHEMA_VIOLATION_FIXTURE = stackFixturePath('cli-validate-schema-violation');
const INVARIANT_FIXTURE = stackFixturePath('invariant-stack-draft-banner');

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

function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-validate-'));
  tmpDirs.push(dir);
  return dir;
}

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
    const direct = validateAll({ projectRoot: SCHEMA_VIOLATION_FIXTURE });
    expect(direct.issues.length).toBeGreaterThan(0);
    const invariantHits = direct.issues.filter(
      (i: Issue) => i.code === 'InvariantViolation',
    );
    expect(invariantHits.length).toBe(0);
  });

  it('exits 2 and prints at least one issue line', async () => {
    const r = await runGan(['validate', '--project-root', SCHEMA_VIOLATION_FIXTURE]);
    expect(r.exitCode).toBe(2);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    // At least one issue line matches the locked regex.
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

    // Seed a project-tier overlay so the project root is well-formed (matches
    // the layout of fixtures used elsewhere). Without it, the scaffold flow
    // still works, but seeding keeps the validate output predictable.
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

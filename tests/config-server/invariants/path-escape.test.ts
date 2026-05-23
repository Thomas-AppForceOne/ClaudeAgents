// Guards the `path.escape` (PathEscape) invariant: every additionalContext
// entry must resolve to a location INSIDE the project root. This is the
// security-critical sibling of `path_resolves` — a missing-but-in-root file is
// merely a warning, but a path that escapes the root (via `../../` or via a
// symlink under `.claude/gan/` pointing outside) is a fatal `error`, because
// it would let an overlay pull arbitrary host files (e.g. /etc/passwd) into a
// run's context.
//
// The two threats are tested separately because they resolve differently:
//   - textual traversal (`../../etc/passwd`) is caught by normalising the
//     declared string;
//   - a symlink looks in-root textually but escapes only after the link is
//     followed, so those cases create a real symlink in a temp tree.
// Tests use a per-test scratch dir (beforeEach/afterEach) plus `makeProject`,
// which writes a stack file and an overlay declaring the given context paths.
// Boundary cases pin that ONLY the escaping entry is reported (valid siblings
// are not), and that a non-existent in-root path is left to `path_resolves`,
// not double-reported here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _runPhase1ForTests, validateAll } from '../../../src/config-server/tools/validate.js';
import { checkPathEscape } from '../../../src/config-server/invariants/path-escape.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

const cleanFixture = path.join(fixturesRoot, 'js-ts-minimal');
const escapeFixture = path.join(fixturesRoot, 'invariant-path-escape');

// Builds a minimal project on disk: a stack file (so phase-1 has something to
// detect) plus a `.claude/gan/project.md` overlay whose proposer/planner
// `additionalContext` lists the supplied paths. The paths are written verbatim
// into the YAML so a test can inject a traversal string or a symlink target.
function makeProject(root: string, proposerPaths: string[], plannerPaths: string[] = []): void {
  const ganDir = path.join(root, '.claude', 'gan');
  mkdirSync(ganDir, { recursive: true });
  const stacksDir = path.join(root, 'stacks');
  mkdirSync(stacksDir, { recursive: true });

  writeFileSync(
    path.join(stacksDir, 'web-node.md'),
    [
      '---',
      'name: web-node',
      'schemaVersion: 1',
      'detection:',
      '  - anyOf:',
      '      - package.json',
      'scope:',
      '  - "**/*.ts"',
      'buildCmd: "npm run build"',
      'testCmd: "npm test"',
      'lintCmd: "npm run lint"',
      '---',
      '',
      '# web-node',
      '',
    ].join('\n'),
    'utf8',
  );

  const yamlLines: string[] = ['---', 'schemaVersion: 1'];
  if (proposerPaths.length > 0) {
    yamlLines.push('proposer:');
    yamlLines.push('  additionalContext:');
    for (const p of proposerPaths) {
      yamlLines.push(`    - "${p}"`);
    }
  }
  if (plannerPaths.length > 0) {
    yamlLines.push('planner:');
    yamlLines.push('  additionalContext:');
    for (const p of plannerPaths) {
      yamlLines.push(`    - "${p}"`);
    }
  }
  yamlLines.push('---');
  yamlLines.push('');
  yamlLines.push('# Project overlay');
  yamlLines.push('');
  writeFileSync(path.join(ganDir, 'project.md'), yamlLines.join('\n'), 'utf8');
}

describe('path.escape (PathEscape) invariant', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'r5-pesc-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns no issues for the clean js-ts-minimal fixture', () => {
    const snapshot = _runPhase1ForTests(cleanFixture);
    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('produces no issues when the path resolves inside the project root', () => {

    writeFileSync(path.join(scratch, 'README.md'), '# hi\n', 'utf8');
    makeProject(scratch, ['README.md']);
    const snapshot = _runPhase1ForTests(scratch);
    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('fires PathEscape when proposer.additionalContext escapes via ../../', () => {
    makeProject(scratch, ['../../etc/passwd']);
    const snapshot = _runPhase1ForTests(scratch);
    const issues = checkPathEscape(snapshot);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue.code).toBe('PathEscape');
    // `error`, not `warning`: escaping the root is a security boundary breach.
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/proposer/additionalContext');
    // `path` echoes the declared (un-normalised) entry verbatim, and the
    // message states why it was rejected.
    expect(issue.path).toBe('../../etc/passwd');
    expect(issue.message).toContain('../../etc/passwd');
    expect(issue.message).toContain('outside the project root');
  });

  it('fires PathEscape on planner.additionalContext too', () => {
    makeProject(scratch, [], ['../../etc/passwd']);
    const snapshot = _runPhase1ForTests(scratch);
    const issues = checkPathEscape(snapshot);
    expect(issues.length).toBe(1);
    expect(issues[0].field).toBe('/planner/additionalContext');
  });

  it('fires PathEscape when a symlink under .claude/gan/ points outside the project root', () => {

    // The hard case: the declared path ('.claude/gan/escape-link.txt') is
    // textually in-root, so only following the symlink reveals the escape. The
    // target is created in a SEPARATE temp dir outside `scratch`, and removed in
    // finally so the secret file never lingers regardless of assertion outcome.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'r5-pesc-out-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret\n', 'utf8');

    try {

      makeProject(scratch, ['.claude/gan/escape-link.txt']);
      const linkPath = path.join(scratch, '.claude', 'gan', 'escape-link.txt');
      symlinkSync(outsideFile, linkPath);

      const snapshot = _runPhase1ForTests(scratch);
      const issues = checkPathEscape(snapshot);
      expect(issues.length).toBe(1);
      expect(issues[0].code).toBe('PathEscape');
      // Reported path is the declared in-root string, not the escaped target.
      expect(issues[0].path).toBe('.claude/gan/escape-link.txt');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not fire when a symlink resolves to a path inside the project root', () => {

    // Mirror of the previous case but with an in-root target: a symlink is fine
    // as long as it does not cross the boundary, proving the check follows links
    // rather than blanket-rejecting them.
    writeFileSync(path.join(scratch, 'target.txt'), 'hi\n', 'utf8');

    makeProject(scratch, ['.claude/gan/inside-link.txt']);
    const linkPath = path.join(scratch, '.claude', 'gan', 'inside-link.txt');
    symlinkSync(path.join(scratch, 'target.txt'), linkPath);

    const snapshot = _runPhase1ForTests(scratch);
    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('reports only the escaping entry from a mix of valid + escaping paths', () => {
    // A valid sibling ('docs.md') must not be flagged alongside the escaper —
    // the check reports each entry independently, not the whole list.
    writeFileSync(path.join(scratch, 'docs.md'), '# docs\n', 'utf8');
    makeProject(scratch, ['docs.md', '../../etc/passwd']);
    const snapshot = _runPhase1ForTests(scratch);
    const issues = checkPathEscape(snapshot);
    expect(issues.length).toBe(1);
    expect(issues[0].path).toBe('../../etc/passwd');
  });

  it('does not throw on non-existent (but in-root) paths — owned by path_resolves', () => {
    // Boundary: a missing in-root file is NOT this invariant's concern; the
    // `path_resolves` invariant warns about it. Here we assert path.escape stays
    // silent so the two invariants do not double-report the same file.
    makeProject(scratch, ['docs/missing.md']);
    const snapshot = _runPhase1ForTests(scratch);

    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('surfaces through validateAll() against the invariant-path-escape fixture', () => {
    const result = validateAll({ projectRoot: escapeFixture });
    const fired = result.issues.find((i) => i.code === 'PathEscape' && i.severity === 'error');
    expect(fired).toBeTruthy();
  });
});

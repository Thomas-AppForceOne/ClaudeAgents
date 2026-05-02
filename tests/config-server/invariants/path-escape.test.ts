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

/**
 * Build a minimal project tree with a project overlay containing the
 * given `additionalContext` paths under `proposer.additionalContext`.
 * Returns the project root.
 */
function makeProject(root: string, proposerPaths: string[], plannerPaths: string[] = []): void {
  const ganDir = path.join(root, '.claude', 'gan');
  mkdirSync(ganDir, { recursive: true });
  const stacksDir = path.join(root, 'stacks');
  mkdirSync(stacksDir, { recursive: true });
  // Minimal stack so phase-1 discovery has something valid to chew on
  // (though path-escape only inspects overlays).
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
    // README.md is a sibling directory entry inside the project root.
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
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/proposer/additionalContext');
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
    // Outside-of-root file we will point a symlink at.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'r5-pesc-out-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret\n', 'utf8');

    try {
      // Create the project and a symlink inside .claude/gan/ pointing at
      // the outside file.
      makeProject(scratch, ['.claude/gan/escape-link.txt']);
      const linkPath = path.join(scratch, '.claude', 'gan', 'escape-link.txt');
      symlinkSync(outsideFile, linkPath);

      const snapshot = _runPhase1ForTests(scratch);
      const issues = checkPathEscape(snapshot);
      expect(issues.length).toBe(1);
      expect(issues[0].code).toBe('PathEscape');
      expect(issues[0].path).toBe('.claude/gan/escape-link.txt');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not fire when a symlink resolves to a path inside the project root', () => {
    // Inside-of-root target.
    writeFileSync(path.join(scratch, 'target.txt'), 'hi\n', 'utf8');

    makeProject(scratch, ['.claude/gan/inside-link.txt']);
    const linkPath = path.join(scratch, '.claude', 'gan', 'inside-link.txt');
    symlinkSync(path.join(scratch, 'target.txt'), linkPath);

    const snapshot = _runPhase1ForTests(scratch);
    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('reports only the escaping entry from a mix of valid + escaping paths', () => {
    writeFileSync(path.join(scratch, 'docs.md'), '# docs\n', 'utf8');
    makeProject(scratch, ['docs.md', '../../etc/passwd']);
    const snapshot = _runPhase1ForTests(scratch);
    const issues = checkPathEscape(snapshot);
    expect(issues.length).toBe(1);
    expect(issues[0].path).toBe('../../etc/passwd');
  });

  it('does not throw on non-existent (but in-root) paths — owned by path_resolves', () => {
    makeProject(scratch, ['docs/missing.md']);
    const snapshot = _runPhase1ForTests(scratch);
    // Non-existent in-root path is not reported by PathEscape (different
    // invariant owns missing-file checks).
    expect(checkPathEscape(snapshot)).toEqual([]);
  });

  it('surfaces through validateAll() against the invariant-path-escape fixture', () => {
    const result = validateAll({ projectRoot: escapeFixture });
    const fired = result.issues.find((i) => i.code === 'PathEscape' && i.severity === 'error');
    expect(fired).toBeTruthy();
  });
});

/**
 * Tests for the SKILL.md documentation of `terminalReason: "failed-evaluation-rejected"`.
 *
 * Three properties pinned:
 *  - the literal kebab-case string is present in the shipped SKILL.md;
 *  - the doc explicitly contrasts the new reason with `LoopDetected` AND
 *    names the renegotiation cap as the firing condition, so a reader can
 *    distinguish rejection (cap-fired-with-blockers) from thrash (loop
 *    detection);
 *  - the SKILL.md edit still satisfies the shipped house-rules and
 *    spec-reference lints (both scripts exit 0 over the file).
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(here), '../..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'gan', 'SKILL.md');

describe('SKILL.md — failed-evaluation-rejected documentation', () => {
  it('contains the literal kebab-case string', () => {
    const src = readFileSync(SKILL_PATH, 'utf8');
    expect(src).toContain('failed-evaluation-rejected');
  });

  it('contrasts the new reason with LoopDetected and names the renegotiation cap', () => {
    const src = readFileSync(SKILL_PATH, 'utf8');
    // The two anchors that together make the contrast actionable:
    // mentioning LoopDetected by name AND naming the cap as the firing
    // condition so a reader can tell which terminal class a halt belongs
    // to without reading the source.
    expect(src).toMatch(/LoopDetected/);
    expect(src).toMatch(/renegotiation cap/i);
  });
});

describe('SKILL.md — shipped lints still pass after the edit', () => {
  // The two lints run against the dist/ build artefact, so we invoke the
  // packaged npm scripts directly to guarantee parity with what CI would
  // see. Both scripts exit non-zero on a violation; checking exit code 0
  // is the contract.

  it('npm run house-rules exits 0', () => {
    expect(() => {
      execFileSync('npm', ['run', '-s', 'house-rules'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });

  it('npm run lint-no-spec-ref exits 0', () => {
    expect(() => {
      execFileSync('npm', ['run', '-s', 'lint-no-spec-ref'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});

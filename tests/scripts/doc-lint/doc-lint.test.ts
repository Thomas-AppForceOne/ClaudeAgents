/**
 * Black-box tests for the `doc-lint` bin — the deterministic documentation
 * gate that reports an exported symbol introduced by the merge-base delta
 * without a doc comment (the lone blocker; every other rule is advisory).
 *
 * The suite drives the compiled bin as a real process against hermetic temp
 * git repositories it builds itself, so the proof is end-to-end through the
 * actual `git merge-base` / `git diff` / `git show` plumbing rather than an
 * in-process stub. Each scenario lays down a `base` branch (the merge-base
 * partner) and a feature branch HEAD, then invokes the tool with `--base-ref`
 * pointing at the base branch — exercising delta-vs-merge-base, NOT a vacuous
 * no-diff run nor an absolute full-tree scan.
 *
 * What is proven:
 * - an empty change (HEAD identical to the base) reports nothing and exits 0;
 * - a diff introducing an undocumented export reports the blocker and exits 1,
 *   while a pre-existing undocumented export is grandfathered (not reported)
 *   and a newly introduced *documented* export produces no finding;
 * - a diff whose only new export is documented exits 0;
 * - the `--json` shape and `--help` (exit 0) behave;
 * - the advisory model: a diff whose only findings are advisory
 *   (an incomplete required-sections doc and/or a commented-out-code comment,
 *   with no undocumented introduced export) reports those advisories AND exits
 *   0; a diff introducing both an undocumented export and an advisory reports
 *   both in the same invocation AND exits 1; the advisory findings carry their
 *   FP caveat and an `advisory` severity in `--json`.
 *
 * The fixture file CONTENTS live under `tests/doc-lint/` and are planted into
 * the temp repo across two revisions, so the fixtures read as named artifacts
 * while the test owns the git topology.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

// Fixture contents directory: tests/doc-lint/, two levels up from this file.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', 'doc-lint');

// Temp repos created per test, swept in afterAll.
const tmpRepos: string[] = [];

/** Read a `tests/doc-lint/*.fixture` file's contents. */
function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

/** Run a git command in `cwd` with an argv array (no shell), discarding stdout. */
function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' });
}

/**
 * Build a hermetic temp git repo with a `base` branch carrying
 * `baseContents` in `module.ts`, then a `feature` branch whose HEAD carries
 * `headContents`. Returns the repo root. The base branch is the merge-base
 * partner the tool is pointed at via `--base-ref base`.
 */
function buildRepo(baseContents: string, headContents: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'doc-lint-'));
  tmpRepos.push(repo);
  git(repo, ['init', '-q']);
  // Local identity + a deterministic default branch name so the topology does
  // not depend on the host git's init.defaultBranch setting.
  git(repo, ['config', 'user.email', 'doc-lint-test@example.invalid']);
  git(repo, ['config', 'user.name', 'doc-lint-test']);
  git(repo, ['checkout', '-q', '-b', 'base']);

  const file = path.join(repo, 'module.ts');
  writeFileSync(file, baseContents, 'utf8');
  git(repo, ['add', 'module.ts']);
  git(repo, ['commit', '-q', '-m', 'base']);

  git(repo, ['checkout', '-q', '-b', 'feature']);
  // Only write a new commit when HEAD diverges; an identical HEAD is the
  // "empty change" case and must leave the feature branch equal to base.
  if (headContents !== baseContents) {
    writeFileSync(file, headContents, 'utf8');
    git(repo, ['add', 'module.ts']);
    git(repo, ['commit', '-q', '-m', 'feature']);
  }
  return repo;
}

afterAll(() => {
  for (const r of tmpRepos) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('doc-lint bin', () => {
  it('empty change (HEAD identical to base) reports nothing and exits 0', async () => {
    const base = fixture('base.module.ts.fixture');
    // HEAD equal to base → merge-base is HEAD → the delta is empty.
    const repo = buildRepo(base, base);
    const r = await runScript('doc-lint', ['--project-root', repo, '--base-ref', 'base']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files checked, 0 failed\n$/);
    expect(r.stderr).toBe('');
  });

  it('delta introducing an undocumented export reports the blocker and exits 1', async () => {
    const repo = buildRepo(
      fixture('base.module.ts.fixture'),
      fixture('head-introduces-undocumented.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', ['--project-root', repo, '--base-ref', 'base']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MissingExportDoc');
    // The introduced undocumented export is reported by name.
    expect(r.stderr).toContain('introducedUndocumented');
    // The pre-existing undocumented export is grandfathered — never reported.
    expect(r.stderr).not.toContain('undocumentedAtBase');
    // The newly introduced DOCUMENTED export produces no finding.
    expect(r.stderr).not.toContain('introducedDocumented');
    // Exactly one file failed (one summary count), one finding row.
    expect(r.stdout).toMatch(/^[0-9]+ files checked, 1 failed\n$/);
  });

  it('delta whose only new export is documented exits 0', async () => {
    const repo = buildRepo(
      fixture('base.module.ts.fixture'),
      fixture('head-all-documented.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', ['--project-root', repo, '--base-ref', 'base']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files checked, 0 failed\n$/);
    expect(r.stderr).toBe('');
  });

  it('--json on an introducing delta emits a canonical document and exits 1', async () => {
    const repo = buildRepo(
      fixture('base.module.ts.fixture'),
      fixture('head-introduces-undocumented.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', [
      '--project-root',
      repo,
      '--base-ref',
      'base',
      '--json',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: { code: string; field?: string; message: string; path: string }[];
    };
    expect(parsed.failed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]!.code).toBe('MissingExportDoc');
    expect(parsed.failures[0]!.field).toBe('introducedUndocumented');
  });

  it('two runs over the same diff produce byte-identical --json output (determinism)', async () => {
    const repo = buildRepo(
      fixture('base.module.ts.fixture'),
      fixture('head-introduces-undocumented.module.ts.fixture'),
    );
    const args = ['--project-root', repo, '--base-ref', 'base', '--json'];
    const a = await runScript('doc-lint', args);
    const b = await runScript('doc-lint', args);
    expect(a.stdout).toBe(b.stdout);
  });

  it('advisory-only delta reports the advisories and exits 0 (no blocker)', async () => {
    const repo = buildRepo(
      fixture('base.advisory.module.ts.fixture'),
      fixture('head-advisory-only.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', ['--project-root', repo, '--base-ref', 'base']);
    // The defining property: advisory findings alone never drive a non-zero exit.
    expect(r.exitCode).toBe(0);
    // The summary still prints (one file failed) AND the advisories are on stderr,
    // so the run is reported, not silent — only the EXIT is clean.
    expect(r.stdout).toMatch(/^[0-9]+ files checked, 1 failed\n$/);
    // Both advisory classes fired in the one invocation.
    expect(r.stderr).toContain('IncompleteDocSections');
    expect(r.stderr).toContain('CommentedOutCode');
    // No blocker — the presence rule's code must be absent.
    expect(r.stderr).not.toContain('MissingExportDoc');
    // The FP caveat is present in the advisory finding text (the honesty contract).
    expect(r.stderr).toContain('advisory (reported, not blocking)');
    expect(r.stderr).toContain('this check cannot soundly tell');
    // Required-sections names its FP cases; commented-out-code names its own.
    expect(r.stderr).toContain('destructured or rest parameters');
    expect(r.stderr).toContain('@example');
  });

  it('advisory + presence blocker in one invocation reports both and exits 1', async () => {
    const repo = buildRepo(
      fixture('base.advisory.module.ts.fixture'),
      fixture('head-advisory-plus-blocker.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', ['--project-root', repo, '--base-ref', 'base']);
    // The blocker drives the non-zero exit...
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MissingExportDoc');
    expect(r.stderr).toContain('introducedUndocumented');
    // ...and the advisories that fired in the SAME run are still reported, not
    // suppressed by the blocker.
    expect(r.stderr).toContain('IncompleteDocSections');
    expect(r.stderr).toContain('CommentedOutCode');
    expect(r.stderr).toContain('advisory (reported, not blocking)');
  });

  it('--json carries the severity discriminator on each finding', async () => {
    const repo = buildRepo(
      fixture('base.advisory.module.ts.fixture'),
      fixture('head-advisory-plus-blocker.module.ts.fixture'),
    );
    const r = await runScript('doc-lint', [
      '--project-root',
      repo,
      '--base-ref',
      'base',
      '--json',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      failures: { code: string; severity?: string; message: string }[];
    };
    const byCode = (code: string) => parsed.failures.find((f) => f.code === code);
    // The presence rule is a blocker; the heuristics are advisory — a machine
    // consumer can route them apart by the `severity` field.
    expect(byCode('MissingExportDoc')!.severity).toBe('blocker');
    expect(byCode('IncompleteDocSections')!.severity).toBe('advisory');
    expect(byCode('CommentedOutCode')!.severity).toBe('advisory');
    // The caveat travels in the message, not only the human stderr render.
    expect(byCode('IncompleteDocSections')!.message).toContain('advisory (reported, not blocking)');
  });

  it('two runs over an advisory+blocker delta produce byte-identical --json (determinism)', async () => {
    const repo = buildRepo(
      fixture('base.advisory.module.ts.fixture'),
      fixture('head-advisory-plus-blocker.module.ts.fixture'),
    );
    const args = ['--project-root', repo, '--base-ref', 'base', '--json'];
    const a = await runScript('doc-lint', args);
    const b = await runScript('doc-lint', args);
    // The three interleaved finding classes must order deterministically.
    expect(a.stdout).toBe(b.stdout);
  });

  it('unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('doc-lint', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('doc-lint', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: doc-lint');
    expect(r.stdout).toContain('--base-ref');
    expect(r.stdout).toContain('Exit codes');
  });
});

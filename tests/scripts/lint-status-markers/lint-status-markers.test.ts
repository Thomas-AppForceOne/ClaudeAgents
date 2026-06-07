/**
 * Black-box tests for the `lint-status-markers` bin, the guard that asserts
 * status-marker discipline on the gan SKILL prose: every runtime-behaviour
 * level-2 heading carries a marker (or qualifies for the multi-flag
 * exemption), and every marker references a release present in the roadmap.
 *
 * The suite drives the compiled bin as a real process: a clean live repo
 * passes (the lint must be green on the worktree the markers were authored
 * against); planted-drift fixtures in temp scan-roots prove each rule; the
 * multi-flag exemption is exercised with a fixture that shares two
 * differing-status flags under one heading; the JSON output is exercised as
 * a parseable, trailing-newline document.
 *
 * Regression guarded: the heading rule silently widening to accept a
 * single-flag section (which would gut the multi-flag exemption's
 * minimum-pair requirement); the release rule silently falling back to a
 * hardcoded version list (which would let a future release-cut drift
 * through); the JSON output growing un-stable ordering or losing its
 * trailing newline (which would break consumers piping into `jq`).
 *
 * NOTE: the writeFileSync payloads below are FIXTURE FILE CONTENTS the bin
 * scans. The marker tokens and heading texts inside them are deliberate
 * test data — do not "fix" them inside those string literals.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { repoRootDir, runScript } from '../helpers/spawn.js';

/**
 * Temp scan-roots created across the suite. Tracked here so the afterAll
 * sweep can remove every one even if a test threw mid-run.
 */
const tmpRoots: string[] = [];

/**
 * Create and register one fresh temp scan-root. The directory is added to
 * the cleanup queue, so the caller does not have to remove it manually.
 */
function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lint-status-markers-'));
  tmpRoots.push(tmp);
  return tmp;
}

/**
 * Stand up the minimum scan-scope skeleton (an empty `skills/gan/`) under
 * `root`. Returns the SKILL directory the test will write its fixture into.
 */
function newSkeletonRoot(): { root: string; skillDir: string } {
  const root = newTmpRoot();
  const skillDir = path.join(root, 'skills', 'gan');
  mkdirSync(skillDir, { recursive: true });
  return { root, skillDir };
}

/**
 * Absolute path to the live roadmap. Tests that exercise the release rule
 * against a planted SKILL fixture point `--roadmap` at this path so the
 * live release set (v1.0/v1.1/v1.2/v2.0) is what the rule validates
 * against — without copying the roadmap into every fixture directory.
 */
const LIVE_ROADMAP_PATH = path.join(repoRootDir(), 'specifications', 'roadmap.md');

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('lint-status-markers bin', () => {
  it('clean live worktree → exit 0; stdout `<N> files scanned, 0 hits\\n`; stderr empty', async () => {
    const r = await runScript('lint-status-markers', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('planted runtime-behaviour heading with no marker → exit 1; finding cites file + MissingStatusMarker', async () => {
    // The canonical drift mode is a level-2 heading that simply forgot the
    // marker; the lint must name the file and the heading so a reviewer
    // can land on the line without re-running the scan.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        '## Some new flow',
        '',
        'Prose without a marker.',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-status-markers', [
      '--scan-root',
      root,
      '--roadmap',
      LIVE_ROADMAP_PATH,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MissingStatusMarker');
    expect(r.stderr).toContain(skillFile);
    expect(r.stderr).toContain('Some new flow');
  });

  it('planted marker citing a release not in roadmap (v9.9) → exit 1; UnknownReleaseInMarker, distinct from MissingStatusMarker', async () => {
    // The release rule is what makes the lint honest: a marker the
    // orchestrator's dispatch cannot act on must fail. The two issue codes
    // must stay distinct so a reviewer can tell prose-omission drift from
    // release-citation drift at a glance.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        '## Some new flow [shipped-in-v9.9]',
        '',
        'Prose with a marker that names a release not on the roadmap.',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-status-markers', [
      '--scan-root',
      root,
      '--roadmap',
      LIVE_ROADMAP_PATH,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('UnknownReleaseInMarker');
    expect(r.stderr).toContain(skillFile);
    expect(r.stderr).toContain('v9.9');
    // The two issue codes must not collapse: the heading carried a marker,
    // so the missing-heading rule must not also fire here. If a future
    // refactor accidentally trips both rules on the same input, this
    // assertion catches the regression.
    expect(r.stderr).not.toContain('MissingStatusMarker');
  });

  it('multi-flag exemption: shared heading with two flags of differing status → exit 0', async () => {
    // A heading that documents two sibling flags of differing status is
    // exempt from the heading-marker requirement when both flags carry
    // markers in the section body. The exemption is what avoids forcing
    // an artificial heading split for prose the runtime contract treats
    // as one section.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        '## Cleanup and recovery',
        '',
        'The `--recover` `[partial-v1.0]` flow ships in the current release.',
        '',
        'The `--cleanup` `[deferred-to-v1.1]` flow is reserved for a later release.',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-status-markers', [
      '--scan-root',
      root,
      '--roadmap',
      LIVE_ROADMAP_PATH,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
  });

  it('single-flag section with one body marker does NOT qualify for the exemption → exit 1', async () => {
    // Multi-flag exemption regression: a single flag with one body marker
    // is precisely the drift mode the threshold of 2 was chosen to reject.
    // If the threshold silently dropped to 1 (or 0), this fixture would
    // pass and the exemption would become a way to dodge the rule.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        '## A single-flag section',
        '',
        'Only one flag here: `--alpha` `[shipped-in-v1.0]`.',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-status-markers', [
      '--scan-root',
      root,
      '--roadmap',
      LIVE_ROADMAP_PATH,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MissingStatusMarker');
    expect(r.stderr).toContain('A single-flag section');
  });

  it('unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('lint-status-markers', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('lint-status-markers', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: lint-status-markers');
    expect(r.stdout).toContain('--scan-root');
    expect(r.stdout).toContain('Exit codes');
  });

  it('--json on clean live worktree → stdout parses as JSON with trailing newline', async () => {
    const r = await runScript('lint-status-markers', ['--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: unknown[];
    };
    expect(parsed.failed).toBe(0);
    expect(parsed.failures).toEqual([]);
    expect(typeof parsed.checked).toBe('number');
  });

  it('--json output is byte-stable across two invocations against the same input', async () => {
    // Byte-stability matters for any consumer comparing the JSON output to
    // a committed golden; a stable shape lets a CI gate catch drift with a
    // diff instead of a tolerant parse-and-compare. Two consecutive runs
    // against the unchanged live worktree must produce byte-identical bytes.
    const a = await runScript('lint-status-markers', ['--json']);
    const b = await runScript('lint-status-markers', ['--json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

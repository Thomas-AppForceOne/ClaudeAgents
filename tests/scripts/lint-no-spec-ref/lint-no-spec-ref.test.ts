/**
 * Black-box tests for the `lint-no-spec-ref` bin, the guard that keeps
 * internal phase-code and spec-path references out of the shipped surface
 * (`agents/` + `skills/gan/`). A finding is a bare-or-possessive phase code
 * (`F4`, `C1's`) on any line, or a `specifications/<CODE>` path, outside the
 * narrow allowlist (the EXAMPLES region in SKILL.md and the status-marker
 * tokens).
 *
 * The suite drives the compiled bin as a real process: a clean live repo
 * passes (the lint must be green on the refactored worktree); planted-drift
 * fixtures in temp scan-roots prove the matcher and the directory walk; the
 * allowlists are exercised both by region and by per-line marker; and the
 * mandatory-`\d+` decision is regression-tested by planting the standalone
 * English words `A` and `I` in prose and asserting they do NOT trigger.
 *
 * Regression guarded: the matcher quietly broadening to single uppercase
 * letters (which would flag every English line), the directory walk shrinking
 * to a fixed file list (which would silently let `trust-prompt.md` drift), or
 * the EXAMPLES allowlist collapsing into a whole-file exempt for SKILL.md
 * (which would gut the lint's coverage of the file's main body).
 *
 * NOTE: the writeFileSync payloads below are FIXTURE FILE CONTENTS the bin
 * scans. The phase codes and spec-path strings inside them are deliberate
 * test data — do not edit inside those string literals.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

// Temp scan-roots created per test, swept in afterAll.
const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lint-no-spec-ref-'));
  tmpRoots.push(tmp);
  return tmp;
}

/**
 * Stand up the minimum scan-scope skeleton (an empty `agents/` and an empty
 * `skills/gan/`) under `root`, so the lint walks a scope with the shape it
 * expects in a real repo. Returns the two created directories for the test to
 * plant fixtures into.
 */
function newSkeletonRoot(): { root: string; agentsDir: string; skillDir: string } {
  const root = newTmpRoot();
  const agentsDir = path.join(root, 'agents');
  const skillDir = path.join(root, 'skills', 'gan');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  return { root, agentsDir, skillDir };
}

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('lint-no-spec-ref bin', () => {
  it('clean canonical repo → exit 0; stdout `<N> files scanned, 0 hits\\n`; stderr empty', async () => {
    const r = await runScript('lint-no-spec-ref', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('planted bare phase code in agents/<file>.md body → exit 1; finding names file + PhaseCodeReferenceDetected', async () => {
    // A bare phase code in agent prose is the canonical drift mode — the
    // matcher must flag it with the file path so a reviewer finds the line.
    const { root, agentsDir } = newSkeletonRoot();
    const planted = path.join(agentsDir, 'test-agent.md');
    writeFileSync(planted, '# Test agent\n\nFollow F4 prose discipline.\n', 'utf8');

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PhaseCodeReferenceDetected');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('F4');
  });

  it('planted possessive phase code (C1\'s) in agent body → exit 1; finding includes the possessive form', async () => {
    // The optional `'s` arm of the matcher is load-bearing for prose like
    // "C1's invariant"; verifying it catches the possessive form proves the
    // arm is wired rather than dead.
    const { root, agentsDir } = newSkeletonRoot();
    const planted = path.join(agentsDir, 'possessive.md');
    writeFileSync(planted, "# Possessive\n\nC1's rule applies here.\n", 'utf8');

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PhaseCodeReferenceDetected');
    expect(r.stderr).toContain("C1's");
  });

  it('planted specifications/<CODE> path in skills/gan/trust-prompt.md → exit 1; demonstrates the walk reaches more than SKILL.md', async () => {
    // The directory walk over skills/gan/ is the part of the spec that says
    // the scope is not a fixed file list. Planting drift specifically in
    // trust-prompt.md proves the walk reaches that file — if the
    // implementation regressed to a fixed list of {SKILL.md}, this test
    // would pass with exit 0 and the regression would land silently.
    const { root, skillDir } = newSkeletonRoot();
    const planted = path.join(skillDir, 'trust-prompt.md');
    writeFileSync(
      planted,
      '# Trust prompt\n\nSee specifications/F2-config-api.md for details.\n',
      'utf8',
    );

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SpecPathReferenceDetected');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('specifications/F2');
  });

  it('--spec specifications/<sample>.md inside SKILL.md EXAMPLES region → exit 0 (allowlisted)', async () => {
    // The EXAMPLES region inside the help-text fenced block is the one place
    // a `--spec specifications/<sample>` example is welcome — the line is
    // part of a user-facing example. The allowlist is line/region-scoped
    // (not whole-file) so the rest of SKILL.md is still policed.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    // The matchable sample path here is `specifications/roadmap-vote.md`,
    // which the path matcher's enumerated letter set already excludes; the
    // region exempt nonetheless protects the line from any future tightening
    // that broadened the matcher.
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        '```',
        'EXAMPLES',
        '  /gan --spec specifications/roadmap-vote.md',
        '',
        'CONFIGURATION',
        '  See docs.',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
  });

  it('SKILL.md body outside the EXAMPLES region is NOT exempt → exit 1 on a planted F4', async () => {
    // The whole-file-exempt regression would silently pass any drift in
    // SKILL.md's main body. This planted F4 outside the EXAMPLES region
    // must still be flagged.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      [
        '# SKILL',
        '',
        'Follow F4 prose discipline in the main body.',
        '',
        '```',
        'EXAMPLES',
        '  /gan --spec specifications/roadmap-vote.md',
        'CONFIGURATION',
        '  docs',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PhaseCodeReferenceDetected');
    expect(r.stderr).toContain('F4');
  });

  it('[shipped-in-v1.0] status-marker token on a SKILL.md line → exit 0 (allowlisted for that token region)', async () => {
    // The status-marker allowlist is defensive: today's floor regex won't
    // match the lowercase `v` in `v1.0`, but a future tightening that did
    // would otherwise flag every `[shipped-in-v<release>]` line. Exempting
    // the literal token now means that tightening cannot break in transit.
    const { root, skillDir } = newSkeletonRoot();
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      skillFile,
      '# SKILL\n\nThe banner is [shipped-in-v1.0]; render unconditionally.\n',
      'utf8',
    );

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
  });

  it('bare English `A` in prose does NOT trigger the matcher (mandatory \\d+)', async () => {
    // Mandatory-digit regression test #1: `A snapshot` is plain English. If
    // the matcher loosened `\d+` to `\d*`, this line would flag every prose
    // line containing a capitalised `A`. The test fails loudly the moment
    // that regression lands.
    const { root, agentsDir } = newSkeletonRoot();
    const planted = path.join(agentsDir, 'english-a.md');
    writeFileSync(
      planted,
      '# English A\n\nA snapshot freezes the run. A reviewer reads it later.\n',
      'utf8',
    );

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
  });

  it('bare English `I` in prose does NOT trigger the matcher (mandatory \\d+)', async () => {
    // Mandatory-digit regression test #2: `I will` is plain English. Same
    // failure mode as the `A` test; both are checked because the matcher's
    // enumerated letter set includes both `A` and `I` and a future widening
    // would flag both.
    const { root, agentsDir } = newSkeletonRoot();
    const planted = path.join(agentsDir, 'english-i.md');
    writeFileSync(planted, '# English I\n\nI will read the spec. I trust the snapshot.\n', 'utf8');

    const r = await runScript('lint-no-spec-ref', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
  });

  it('unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('lint-no-spec-ref', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('lint-no-spec-ref', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: lint-no-spec-ref');
    expect(r.stdout).toContain('--scan-root');
    expect(r.stdout).toContain('Exit codes');
  });

  it('--json on clean canonical repo → stdout parses as JSON with trailing newline', async () => {
    const r = await runScript('lint-no-spec-ref', ['--json']);
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
});

/**
 * End-to-end tests for the W1 overlay-misuse warning surface on
 * `gan stacks list`.
 *
 * Covers the two human shapes (the active-vs-suppressed breakdown when a
 * StackOverrideShrinkage warning is present, and the preserved one-name-per-line
 * output when no shrinkage applies) and the always-present top-level `warnings`
 * array under `--json`. The fixtures are the Sprint-1 overlay-warn-* projects,
 * so the surface is exercised against the real data layer rather than a stub.
 *
 * The breakdown gate is verified to be strictly the StackOverrideShrinkage
 * code: a PerStackOverrideUnsupported warning alone (overlay-warn-per-stack-*)
 * must NOT trigger the breakdown, since it does not change the active set.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import type { Warning } from '../../src/index.js';

describe('gan stacks list — W1 warnings', () => {
  it('human format annotates active vs. suppressed when StackOverrideShrinkage is present', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    // The breakdown must reproduce the W1 spec example block verbatim:
    // ACTIVE header + two-space-indented active names, a blank line, the
    // SUPPRESSED header + annotated suppressed names, a blank line, then the
    // two-line remediation pointer.
    expect(r.stdout).toBe(
      'ACTIVE for this directory:\n' +
        '  php-grav\n' +
        '\n' +
        'SUPPRESSED by stack.override:\n' +
        '  web-node (would have been activated by detection)\n' +
        '\n' +
        'For full coverage, list every stack you want active in stack.override.\n' +
        'See `gan stacks --help` for the active-vs-available distinction.\n',
    );
  });

  it('human format keeps one-name-per-line when no shrinkage warning applies', async () => {
    // overlay-warn-single-detection produces NO warning at all: the script
    // path must be byte-for-byte the pre-W1 shape (one name, trailing newline).
    const fixture = stackFixturePath('overlay-warn-single-detection');
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('php-grav\n');
    expect(r.stdout).not.toContain('ACTIVE for this directory:');
    expect(r.stdout).not.toContain('SUPPRESSED');
  });

  it('a PerStackOverrideUnsupported warning alone does NOT trigger the breakdown', async () => {
    // overlay-warn-per-stack-secret carries a PerStackOverrideUnsupported
    // warning but no shrinkage; the active set is unchanged, so the human
    // surface stays on the one-name-per-line path.
    const fixture = stackFixturePath('overlay-warn-per-stack-secret');
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    // No breakdown framing whatsoever — the surface stays on the script path.
    expect(r.stdout).not.toContain('ACTIVE for this directory:');
    expect(r.stdout).not.toContain('SUPPRESSED');
    expect(r.stdout).not.toContain('would have been activated');
    // The fixture none the less carries the per-stack warning under --json, so
    // confirm the breakdown was suppressed despite a warning being present.
    const j = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    const parsed = JSON.parse(j.stdout) as { warnings: Warning[] };
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe('PerStackOverrideUnsupported');
  });

  it('--json always carries a top-level warnings array (populated when shrinkage present)', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(r.stdout) as { active: string[]; warnings: Warning[] };
    // The existing `active` array is unchanged and still present.
    expect(parsed.active).toEqual(['php-grav']);
    // The warnings array carries the shrinkage warning with its code, message,
    // and details read verbatim from the snapshot.
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe('StackOverrideShrinkage');
    expect(parsed.warnings[0].message).toContain('stack.override');
    expect(parsed.warnings[0].details).toMatchObject({
      code: 'StackOverrideShrinkage',
      suppressed: ['web-node'],
    });
  });

  it('--json carries an empty warnings array when no warning applies', async () => {
    const fixture = stackFixturePath('overlay-warn-single-detection');
    const r = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { active: string[]; warnings: Warning[] };
    expect(parsed.warnings).toEqual([]);
    expect(parsed.active).toEqual(['php-grav']);
  });

  it('--json output is deterministic across runs (stable key order)', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const a = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    const b = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(a.stdout).toBe(b.stdout);
  });
});

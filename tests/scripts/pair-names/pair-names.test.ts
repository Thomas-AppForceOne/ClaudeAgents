/**
 * Black-box tests for the `pair-names` bin, which enforces the C5
 * "pairs-with consistency" invariant across a project's stack files: if one
 * stack declares `pairsWith` another, that pairing must be mutually
 * consistent and not reference a shadowed stack.
 *
 * The suite drives the compiled bin against two checked-in fixtures: a clean
 * project that passes, and an `invariant-pairs-with-shadowed` project where a
 * stack pairs with a shadowed `docker` stack — which must fail with
 * InvariantViolation, naming the C5 message tokens (`pairs-with.consistency`,
 * `pairsWith: docker`), the offending stack's canonical path, and the
 * `/pairsWith` field in the --json failure. Unknown-flag (exit 64) and --help
 * paths are also covered.
 *
 * Regression guarded: the C5 invariant check going quiet on a shadowed
 * pairing, or dropping the field/path/message detail downstream tools rely on.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { runScript, repoRootDir } from '../helpers/spawn.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const FIXTURES = path.join(repoRootDir(), 'tests', 'fixtures', 'stacks');
// A project that satisfies C5, and one that violates it via a shadowed pairing.
const CLEAN_ROOT = path.join(FIXTURES, 'js-ts-minimal');
const SHADOWED_ROOT = path.join(FIXTURES, 'invariant-pairs-with-shadowed');

beforeAll(() => {
  // Fail fast if a fixture is missing rather than misattributing the cause
  // later inside a bin assertion.
  for (const p of [CLEAN_ROOT, SHADOWED_ROOT]) {
    if (!existsSync(p)) {
      throw new Error(`fixture missing: ${p}`);
    }
  }
});

describe('pair-names bin', () => {
  it('clean fixture → exit 0 with `1 stacks checked, 0 failed`', async () => {
    const r = await runScript('pair-names', ['--project-root', CLEAN_ROOT]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('1 stacks checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('shadowed fixture → exit 1 with `2 stacks checked, 1 failed`; stderr names the C5 message tokens', async () => {
    const r = await runScript('pair-names', ['--project-root', SHADOWED_ROOT]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('2 stacks checked, 1 failed\n');
    expect(r.stderr).toContain('InvariantViolation');
    expect(r.stderr).toContain('pairs-with.consistency');
    expect(r.stderr).toContain('pairsWith: docker');

    const canonical = canonicalizePath(SHADOWED_ROOT);
    const stackPath = path.join(canonical, '.claude', 'gan', 'stacks', 'docker.md');
    expect(r.stderr).toContain(stackPath);
  });

  it('--json against shadowed fixture → exit 1, parseable JSON, trailing newline, expected shape', async () => {
    const r = await runScript('pair-names', ['--project-root', SHADOWED_ROOT, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: Array<{ path: string; code: string; message: string; field?: string }>;
    };
    expect(parsed.checked).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    const failure = parsed.failures[0]!;
    expect(failure.code).toBe('InvariantViolation');
    expect(typeof failure.message).toBe('string');
    expect(failure.message).toContain('pairs-with.consistency');
    expect(failure.message).toContain('pairsWith: docker');
    const canonical = canonicalizePath(SHADOWED_ROOT);
    const stackPath = path.join(canonical, '.claude', 'gan', 'stacks', 'docker.md');
    expect(failure.path).toBe(stackPath);
    expect(failure.field).toBe('/pairsWith');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('pair-names', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: pair-names');
    expect(r.stdout).toContain('--project-root');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('Exit codes');
  });

  it('unknown flag → exit 64 with stdout empty and stderr pointer to --help', async () => {
    const r = await runScript('pair-names', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });
});

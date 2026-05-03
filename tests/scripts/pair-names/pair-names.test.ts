/**
 * Integration tests for `scripts/pair-names/`.
 *
 * Spawns the built bin (`dist/scripts/pair-names/index.js`) under
 * controlled fixtures and asserts:
 *
 *   - clean fixture (`js-ts-minimal`) → exit 0, summary
 *     `1 stacks checked, 0 failed`.
 *   - shadowed fixture (`invariant-pairs-with-shadowed`) → exit 1,
 *     summary `2 stacks checked, 1 failed`; stderr names the
 *     `InvariantViolation` code, the `pairs-with.consistency` prose,
 *     `pairsWith: docker`, and the canonicalised absolute path of the
 *     project-tier `.claude/gan/stacks/docker.md` file.
 *   - `--json` against the shadowed fixture → stdout parses as JSON
 *     with the documented `{checked, failed, failures: [...]}` shape
 *     and a trailing newline; stderr is empty.
 *   - `--help` → exit 0, stdout names `Usage: pair-names`, stderr empty.
 *   - unknown flag → exit 64, stderr names the offending token and
 *     `--help`.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { runScript, repoRootDir } from '../helpers/spawn.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const FIXTURES = path.join(repoRootDir(), 'tests', 'fixtures', 'stacks');
const CLEAN_ROOT = path.join(FIXTURES, 'js-ts-minimal');
const SHADOWED_ROOT = path.join(FIXTURES, 'invariant-pairs-with-shadowed');

beforeAll(() => {
  // Sanity: every fixture path exists. If a future refactor moves them
  // we want the test to fail fast with a clear message rather than
  // exit-1 on every assertion.
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
    // The reported path is the canonicalised absolute path of the
    // project-tier shadow file.
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

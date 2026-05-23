/**
 * Black-box tests for the `lint-stacks` bin, which validates a project's stack
 * `.md` files against the stack schema and a set of authoring rules. Each test
 * points the bin at a checked-in fixture root and asserts on its exit code,
 * summary line, and the failure code/path it reports.
 *
 * Coverage spans the bin's failure taxonomy: an empty stacks dir (0 checked),
 * a clean stack (pass), a leftover scaffold DRAFT banner
 * (ScaffoldBannerPresent), a schema-shape violation and a malformed
 * docLintCmd (both SchemaMismatch), plus the --json output shape and the
 * unknown-flag (exit 64) / --help paths.
 *
 * Regression guarded: the bin must keep reporting the right failure CODE and
 * the offending stack file's PATH for each defect class, since CI and authors
 * key off both.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { runScript, repoRootDir } from '../helpers/spawn.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

// One fixture root per defect class the bin must distinguish.
const FIXTURES = path.join(repoRootDir(), 'tests', 'fixtures', 'scripts', 'lint-stacks');
const EMPTY_ROOT = path.join(FIXTURES, 'empty');
const CLEAN_ROOT = path.join(FIXTURES, 'clean');
const DRAFT_ROOT = path.join(FIXTURES, 'draft-banner');
const SCHEMA_ROOT = path.join(FIXTURES, 'schema-violation');
const DOCLINT_ROOT = path.join(FIXTURES, 'malformed-doclintcmd');

beforeAll(() => {
  // Fail fast with a clear message if a fixture is missing, rather than letting
  // the bin produce a confusing "0 checked" pass later.
  for (const p of [EMPTY_ROOT, CLEAN_ROOT, DRAFT_ROOT, SCHEMA_ROOT, DOCLINT_ROOT]) {
    if (!existsSync(p)) {
      throw new Error(`fixture missing: ${p}`);
    }
  }
});

describe('lint-stacks bin', () => {
  it('A19a: empty stacks dir → exit 0 with `0 stacks checked, 0 failed`', async () => {
    const r = await runScript('lint-stacks', ['--project-root', EMPTY_ROOT]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('0 stacks checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('A19b: clean fixture → exit 0 with `1 stacks checked, 0 failed`', async () => {
    const r = await runScript('lint-stacks', ['--project-root', CLEAN_ROOT]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('1 stacks checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('A20: draft-banner fixture → exit 1, stderr names the path and `ScaffoldBannerPresent`', async () => {
    const r = await runScript('lint-stacks', ['--project-root', DRAFT_ROOT]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('1 stacks checked, 1 failed\n');
    expect(r.stderr).toContain('ScaffoldBannerPresent');

    // The bin reports the CANONICAL path, so build the expected path the same
    // way to compare apples to apples.
    const canonical = canonicalizePath(DRAFT_ROOT);
    const stackPath = path.join(canonical, 'stacks', 'web-node.md');
    expect(r.stderr).toContain(stackPath);
  });

  it('A19c: schema-violation fixture → exit 1, stderr names `SchemaMismatch`', async () => {
    const r = await runScript('lint-stacks', ['--project-root', SCHEMA_ROOT]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('1 stacks checked, 1 failed\n');
    expect(r.stderr).toContain('SchemaMismatch');
    const canonical = canonicalizePath(SCHEMA_ROOT);
    const stackPath = path.join(canonical, 'stacks', 'web-node.md');
    expect(r.stderr).toContain(stackPath);
  });

  it('Q5: malformed docLintCmd fixture → exit 1, stderr names `SchemaMismatch`', async () => {

    const r = await runScript('lint-stacks', ['--project-root', DOCLINT_ROOT]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('1 stacks checked, 1 failed\n');
    expect(r.stderr).toContain('SchemaMismatch');
    const canonical = canonicalizePath(DOCLINT_ROOT);
    const stackPath = path.join(canonical, 'stacks', 'web-node.md');
    expect(r.stderr).toContain(stackPath);
  });

  it('Q5: --json against malformed docLintCmd → SchemaMismatch in the failures list', async () => {
    const r = await runScript('lint-stacks', ['--project-root', DOCLINT_ROOT, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: Array<{ path: string; code: string; message: string }>;
    };
    expect(parsed.checked).toBe(1);
    expect(parsed.failed).toBeGreaterThanOrEqual(1);
    expect(parsed.failures.some((f) => f.code === 'SchemaMismatch')).toBe(true);
  });

  it('A21: --json against draft-banner → stdout parses as JSON, trailing newline', async () => {
    const r = await runScript('lint-stacks', ['--project-root', DRAFT_ROOT, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: Array<{ path: string; code: string; message: string }>;
    };
    expect(parsed.checked).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]!.code).toBe('ScaffoldBannerPresent');
    const canonical = canonicalizePath(DRAFT_ROOT);
    const stackPath = path.join(canonical, 'stacks', 'web-node.md');
    expect(parsed.failures[0]!.path).toBe(stackPath);
    expect(typeof parsed.failures[0]!.message).toBe('string');
  });

  it('A19d: unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('lint-stacks', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('lint-stacks', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: lint-stacks');
    expect(r.stdout).toContain('--project-root');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('Exit codes');
  });
});

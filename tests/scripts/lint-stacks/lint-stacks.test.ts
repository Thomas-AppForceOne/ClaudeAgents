/**
 * Integration tests for `scripts/lint-stacks/`.
 *
 * Spawns the built bin (`dist/scripts/lint-stacks/index.js`) under
 * controlled fixtures and asserts:
 *
 *   - empty stacks dir → exit 0, summary `0 stacks checked, 0 failed`.
 *   - clean fixture → exit 0, summary `1 stacks checked, 0 failed`.
 *   - draft-banner fixture → exit 1, stderr names the absolute path
 *     and the `ScaffoldBannerPresent` issue code.
 *   - schema-violation fixture → exit 1, stderr names the
 *     `SchemaMismatch` issue code.
 *   - `--json` against draft-banner → stdout parses as JSON with the
 *     documented `{checked, failed, failures: [...]}` shape and a
 *     trailing newline.
 *   - unknown flag → exit 64.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { runScript, repoRootDir } from '../helpers/spawn.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const FIXTURES = path.join(repoRootDir(), 'tests', 'fixtures', 'scripts', 'lint-stacks');
const EMPTY_ROOT = path.join(FIXTURES, 'empty');
const CLEAN_ROOT = path.join(FIXTURES, 'clean');
const DRAFT_ROOT = path.join(FIXTURES, 'draft-banner');
const SCHEMA_ROOT = path.join(FIXTURES, 'schema-violation');

beforeAll(() => {
  // Sanity: every fixture path exists. If a future refactor moves them
  // we want the test to fail fast with a clear message rather than
  // exit-1 on every assertion.
  for (const p of [EMPTY_ROOT, CLEAN_ROOT, DRAFT_ROOT, SCHEMA_ROOT]) {
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
    // The reported path is the canonicalised absolute path; the
    // fixture's project root is canonicalised, then `/stacks/` joined.
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

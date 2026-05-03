/**
 * Integration tests for `scripts/lint-error-text/`.
 *
 * Spawns the built bin (`dist/scripts/lint-error-text/index.js`) and
 * asserts:
 *
 *   - default run (no flags) → exit 0; stdout matches
 *     `^[0-9]+ files scanned, 0 hits\n$`; stderr empty;
 *   - hermetic temp scan-root with a planted emit-site leak → exit 1;
 *     stderr contains `ErrorTextLeakDetected`;
 *   - bare-token outside an emit site (string assignment, comment) →
 *     exit 0 (the heuristic is emit-site-scoped, not vocabulary-wide);
 *   - `--json` clean run → stdout parses as JSON with the documented
 *     `{checked, failed, failures: []}` shape and a trailing newline;
 *   - unknown flag → exit 64.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lint-error-text-'));
  tmpRoots.push(tmp);
  return tmp;
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

describe('lint-error-text bin', () => {
  it('clean canonical repo → exit 0; stdout `<N> files scanned, 0 hits\\n`; stderr empty', async () => {
    const r = await runScript('lint-error-text', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('hermetic temp scan-root with a planted emit-site leak → exit 1; stderr names ErrorTextLeakDetected', async () => {
    const root = newTmpRoot();
    const cfgDir = path.join(root, 'src', 'config-server');
    mkdirSync(cfgDir, { recursive: true });
    const planted = path.join(cfgDir, 'foo.ts');
    writeFileSync(
      planted,
      [
        'export function fail(): { message: string } {',
        '  return { message: "run npm install to fix" };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-error-text', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('ErrorTextLeakDetected');
    expect(r.stderr).toContain(planted);
  });

  it('bare-token outside an emit site → exit 0 (heuristic does not fire)', async () => {
    const root = newTmpRoot();
    const cfgDir = path.join(root, 'src', 'config-server');
    mkdirSync(cfgDir, { recursive: true });
    const planted = path.join(cfgDir, 'bar.ts');
    writeFileSync(
      planted,
      [
        '// A comment mentioning node_modules — not user-facing.',
        'export const x = "node_modules";',
        'export const y = "package.json";',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runScript('lint-error-text', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('--json on clean canonical repo → stdout parses as JSON with trailing newline', async () => {
    const r = await runScript('lint-error-text', ['--json']);
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

  it('unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('lint-error-text', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('lint-error-text', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: lint-error-text');
    expect(r.stdout).toContain('--scan-root');
    expect(r.stdout).toContain('Exit codes');
  });
});

/**
 * Black-box tests for the `lint-error-text` bin, which scans config-server
 * source for user-facing error messages that leak environment-specific
 * tooling text (package-manager invocations, file names like node_modules /
 * package.json) into error strings the end user shouldn't see.
 *
 * The detector is intentionally heuristic: it fires only at an "emit site" (a
 * value being returned/thrown as an error message), not on every mention of a
 * forbidden token. The suite proves both directions — a planted leak at an
 * emit site is caught (ErrorTextLeakDetected), while the same tokens sitting
 * in a comment or a plain constant do NOT trip it — plus the --json shape,
 * unknown-flag (exit 64), and --help behaviour.
 *
 * Regression guarded: a detector change that either stopped catching real
 * emit-site leaks or started false-positiving on bare token mentions.
 *
 * NOTE: the writeFileSync payloads below are FIXTURE SOURCE — the planted .ts
 * files the bin scans. Their contents (including any token or // sequence) are
 * the data the test asserts on; do not edit inside those string literals.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

// Temp scan-roots created per test, swept in afterAll.
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
    // The bin scans src/config-server, so plant the fixture there.
    const cfgDir = path.join(root, 'src', 'config-server');
    mkdirSync(cfgDir, { recursive: true });
    const planted = path.join(cfgDir, 'foo.ts');
    // Fixture below returns a tooling string as an error message — an emit-site
    // leak the detector must flag.
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
    // Same tokens, but only in a comment and a plain constant — no emit site,
    // so the heuristic must stay quiet (the false-positive guard).
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

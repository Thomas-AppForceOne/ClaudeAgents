/**
 * Black-box tests for the `lint-no-stack-leak` bin, the guard that keeps
 * stack-specific / ecosystem-specific instructions from leaking into the
 * stack-agnostic shipped surface (the `agents/` files). A leak is a forbidden
 * token (e.g. a package-manager command) appearing in a file that is supposed
 * to stay generic.
 *
 * The suite drives the compiled bin as a real process: a clean canonical repo
 * passes; a planted leaking agent file is caught (LeakDetected); the --json
 * shape and unknown-flag (exit 64) / --help paths behave; and the
 * allowlist's "transitional" entries are policed — a transitional entry that
 * points at a file with no actual forbidden token is itself an error
 * (EmptyTransitionalEntry), so stale exemptions can't accumulate.
 *
 * Regression guarded: the leak detector going quiet on a real leak, or the
 * allowlist letting a rotted transitional entry linger unnoticed.
 *
 * NOTE: the writeFileSync payloads below are FIXTURE FILE CONTENTS the bin
 * scans (and the allowlist JSON it reads). The forbidden tokens inside them
 * are deliberate test data — do not edit inside those string/object literals.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

// Temp scan-roots created per test, swept in afterAll.
const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lint-no-stack-leak-'));
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

describe('lint-no-stack-leak bin', () => {
  it('clean canonical repo → exit 0; stdout `<N> files scanned, 0 hits\\n`; stderr empty', async () => {
    const r = await runScript('lint-no-stack-leak', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('hermetic temp scan-root with a leaking agent file → exit 1; stderr names LeakDetected', async () => {
    const root = newTmpRoot();
    // Leaks are policed under agents/; plant a file there carrying a forbidden
    // package-manager command (the leak the bin must detect).
    const agentsDir = path.join(root, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const planted = path.join(agentsDir, 'test.md');
    writeFileSync(planted, '# Test agent\n\nRun `npm install` to set up.\n', 'utf8');

    const r = await runScript('lint-no-stack-leak', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('LeakDetected');
    expect(r.stderr).toContain(planted);
  });

  it('--json on clean canonical repo → stdout parses as JSON with trailing newline', async () => {
    const r = await runScript('lint-no-stack-leak', ['--json']);
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
    const r = await runScript('lint-no-stack-leak', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('transitional entry referencing a file with no forbidden token → exit 1; stderr names EmptyTransitionalEntry', async () => {
    const root = newTmpRoot();
    const agentsDir = path.join(root, 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // A clean file (no forbidden token) that the allowlist nonetheless exempts.
    const stale = path.join(agentsDir, 'stale.md');
    writeFileSync(stale, '# Stale agent\n\nNothing leaky here.\n', 'utf8');

    // The transitional exemption points at that clean file — a rotted entry the
    // bin must reject so dead exemptions don't pile up.
    const allowlistPath = path.join(root, 'allowlist.json');
    const allowlist = {
      paths: {},
      transitional: {
        'agents/stale.md': 'this transitional entry has rotted',
      },
    };
    writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2) + '\n', 'utf8');

    const r = await runScript('lint-no-stack-leak', [
      '--scan-root',
      root,
      '--allowlist-file',
      allowlistPath,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EmptyTransitionalEntry');
    expect(r.stderr).toContain('agents/stale.md');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('lint-no-stack-leak', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: lint-no-stack-leak');
    expect(r.stdout).toContain('--scan-root');
    expect(r.stdout).toContain('Exit codes');
  });
});

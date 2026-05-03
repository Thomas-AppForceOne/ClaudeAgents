/**
 * Integration tests for `scripts/lint-no-stack-leak/`.
 *
 * Spawns the built bin (`dist/scripts/lint-no-stack-leak/index.js`) and
 * asserts:
 *
 *   - default run (no flags) → exit 0; stdout matches
 *     `^[0-9]+ files scanned, 0 hits\n$`; stderr empty;
 *   - hermetic temp scan-root with a planted leaking agent file → exit 1;
 *     stderr contains `LeakDetected`;
 *   - `--json` clean run → stdout parses as JSON with the documented
 *     `{checked, failed, failures: []}` shape and a trailing newline;
 *   - unknown flag → exit 64;
 *   - hermetic temp scan-root + `--allowlist-file` pointing to a JSON
 *     whose transitional entry references a file with no forbidden
 *     token → exit 1; stderr contains `EmptyTransitionalEntry`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

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
    // Planted file has zero forbidden tokens — the transitional entry
    // covering it is therefore stale and must fire EmptyTransitionalEntry.
    const stale = path.join(agentsDir, 'stale.md');
    writeFileSync(stale, '# Stale agent\n\nNothing leaky here.\n', 'utf8');

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

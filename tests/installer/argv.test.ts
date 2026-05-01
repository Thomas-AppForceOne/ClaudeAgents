/**
 * R2 sprint 1 — argv routing tests.
 *
 * Confirms that the bare invocation, --uninstall, and --help short-circuit
 * each route to the expected placeholder body. Filesystem mutation is out of
 * scope for sprint 1, so these tests only assert exit codes and observable
 * stdout/stderr text.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnInstaller } from './_spawn.js';

const SYSTEM_UTILITIES = [
  '/bin/cat',
  '/bin/ls',
  '/usr/bin/uname',
  '/usr/bin/dirname',
  '/usr/bin/printf',
  '/usr/bin/env',
];

function makeStubBin(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-installer-stub-'));
  for (const src of SYSTEM_UTILITIES) {
    const name = path.basename(src);
    try {
      symlinkSync(src, path.join(dir, name));
    } catch {
      // utility may not exist on this platform
    }
  }
  return dir;
}

describe('install.sh argv routing', () => {
  it('install path (no flags) reaches the placeholder install body', async () => {
    const result = await spawnInstaller({ args: [] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/installer skeleton/i);
    expect(result.stdout).not.toMatch(/uninstall/i);
  });

  it('uninstall path (--uninstall) reaches the placeholder uninstall body', async () => {
    const result = await spawnInstaller({ args: ['--uninstall'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/uninstall/i);
  });

  it('--help short-circuits over --uninstall (and over prereq checks)', async () => {
    // Stub bin lacks node/git/claude entirely — if --help did not short-circuit
    // we would hit a prereq failure and exit non-zero.
    const stubBin = makeStubBin();
    try {
      const result = await spawnInstaller({
        args: ['--help', '--uninstall'],
        pathOverride: stubBin,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--uninstall');
      // Help body, not uninstall body.
      expect(result.stdout).not.toMatch(/uninstaller skeleton/i);
    } finally {
      rmSync(stubBin, { recursive: true, force: true });
    }
  });
});

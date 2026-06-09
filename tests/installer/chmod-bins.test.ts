/**
 * CI coverage for the postbuild bin-chmod hook (`scripts/chmod-bins.mjs`).
 *
 * Sprint 1's decisive proof that the installed bins are runnable lives in the
 * live-install path (`tests/installer/live-install.sh`), which is not in CI.
 * This test gives the chmod mechanic a fast, hermetic unit check that DOES run
 * in CI: it drives the REAL `scripts/chmod-bins.mjs` (no copy, no re-implement)
 * against a throwaway fixture tree via the script's `CAS_CHMOD_BINS_ROOT`
 * test-only root override, and asserts the execute bit lands on every declared
 * `bin` target while the read/write bits are preserved.
 *
 * What it verifies:
 * - the execute bit (`mode & 0o111`) is set on every `package.json` `bin`
 *   target, including a nested one, and the rw bits (`mode & 0o600`) survive;
 * - the hook is idempotent — a second run leaves the mode byte-stable;
 * - a declared bin target that does not exist (a missing built entrypoint, a
 *   real build defect) makes the hook exit non-zero.
 *
 * Hermetic: every byte is written under a fresh `mkdtempSync` temp root that is
 * removed in `afterEach`. It never touches the real repo `dist/`, the global
 * npm prefix, or `~/.claude`. The shebang strings written into the stub bin
 * targets below are DATA in fixture files, not directives on this module.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The test file lives at <repoRoot>/tests/installer/, so the repo root is two
// directories up — robust regardless of the cwd vitest was launched from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const chmodBinsScript = path.join(repoRoot, 'scripts', 'chmod-bins.mjs');

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort; the OS reaper will catch leaks
    }
  }
});

/**
 * Mint a throwaway package root with a `package.json` carrying the given `bin`
 * map. Returns the absolute temp root; registered for `afterEach` cleanup.
 */
function makeFixtureRoot(bin: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-chmod-bins-'));
  tmpRoots.push(root);
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', bin }, null, 2) + '\n',
  );
  return root;
}

/** Create a non-executable (0o644) stub bin target at `<root>/<relPath>`. */
function writeBinTarget(root: string, relPath: string): string {
  const target = path.resolve(root, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o644 });
  return target;
}

/** Run the real chmod-bins.mjs pointed at `root` via the test-only override. */
function runChmodBins(root: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [chmodBinsScript], {
    encoding: 'utf8',
    env: { ...process.env, CAS_CHMOD_BINS_ROOT: root },
  });
}

describe('scripts/chmod-bins.mjs — postbuild bin-chmod hook', () => {
  it('sets the execute bit on every declared bin target (incl. nested) and preserves the read/write bits', () => {
    const root = makeFixtureRoot({
      foo: './dist/foo.js',
      bar: './dist/bar/bar.js',
    });
    const foo = writeBinTarget(root, './dist/foo.js');
    const bar = writeBinTarget(root, './dist/bar/bar.js');

    const result = runChmodBins(root);
    expect(result.status).toBe(0);

    for (const target of [foo, bar]) {
      const mode = statSync(target).mode;
      // Mirrors the confineHook precedent's `mode & 0o100` assertion, widened
      // to `0o111` so any of owner/group/other execute counts as "+x".
      expect(mode & 0o111).not.toBe(0);
      // The original 0o644 read/write bits must survive the OR-in of +x.
      expect(mode & 0o600).toBe(0o600);
    }
  });

  it('is idempotent: a second run exits 0 and leaves the mode byte-stable', () => {
    const root = makeFixtureRoot({
      foo: './dist/foo.js',
      bar: './dist/bar/bar.js',
    });
    const foo = writeBinTarget(root, './dist/foo.js');
    const bar = writeBinTarget(root, './dist/bar/bar.js');

    const first = runChmodBins(root);
    expect(first.status).toBe(0);

    const afterFirst = [foo, bar].map((t) => statSync(t).mode);

    const second = runChmodBins(root);
    expect(second.status).toBe(0);

    const afterSecond = [foo, bar].map((t) => statSync(t).mode);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('exits non-zero when a declared bin target does not exist (missing built bin is a real defect)', () => {
    // The package.json declares a bin whose target file is never created.
    const root = makeFixtureRoot({ ghost: './dist/ghost.js' });

    const result = runChmodBins(root);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });
});

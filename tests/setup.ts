/**
 * Vitest global setup: isolate every test from the framework's own
 * `<repoRoot>/stacks/` directory.
 *
 * As of Phase 3 / Sprint 1 the repo ships canonical built-in stack
 * files at `<repoRoot>/stacks/web-node.md` and `<repoRoot>/stacks/generic.md`
 * (per E2). The default `packageRoot()` resolution walks up from
 * `import.meta.url` to find the framework's package.json, which during
 * tests is the repo root itself — so without an override every test
 * that doesn't pass `packageRoot:` explicitly would resolve the canonical
 * stacks instead of its fixture-local copies.
 *
 * Strategy: create a per-session tmp dir containing a copy of the
 * framework's `package.json` (so `readApiVersion()` and similar
 * `<packageRoot>/package.json` reads keep working) but **no** `stacks/`
 * subdir. Set `GAN_PACKAGE_ROOT_OVERRIDE` to that tmp dir. The C5
 * resolver's tier-3 lookup at `<override>/stacks/<name>.md` returns
 * empty, the tier-4 fixture fallback (`<projectRoot>/stacks/<name>.md`)
 * wins, and every fixture-using test sees the same behaviour it did
 * before the canonical stacks shipped.
 *
 * Tests that genuinely need a populated package tier still pass
 * `packageRoot:` explicitly and bypass this default. Spawned-script
 * tests inherit the override through `tests/.../helpers/spawn.ts`,
 * which forwards `GAN_PACKAGE_ROOT_OVERRIDE` from the parent vitest
 * process.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.env.GAN_PACKAGE_ROOT_OVERRIDE === undefined) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const realPackageJson = path.join(repoRoot, 'package.json');

  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'cas-tests-empty-package-root-'));
  if (existsSync(realPackageJson)) {
    copyFileSync(realPackageJson, path.join(fakeRoot, 'package.json'));
  } else {
    // Defensive: should never happen in repo-rooted test runs, but
    // produce a minimally-valid package.json if it does.
    mkdirSync(fakeRoot, { recursive: true });
  }

  process.env.GAN_PACKAGE_ROOT_OVERRIDE = fakeRoot;
}

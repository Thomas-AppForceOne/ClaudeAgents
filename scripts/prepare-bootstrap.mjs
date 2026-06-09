#!/usr/bin/env node
/*
 * Self-bootstrapping `prepare` helper.
 *
 * For a local-directory `npm install -g .`, npm does NOT pre-install
 * devDependencies and runs `prepare` IN-PLACE in the repo dir, so `prepare`
 * cannot assume `tsc` exists. This helper bootstraps the build toolchain when
 * needed, then runs the build, so a bare `npm install -g .` on a clean
 * checkout (no node_modules, no dist/) produces the dist/ bin entrypoints.
 *
 * RECURSION HAZARD: `npm ci` and `npm install` (no args) BOTH re-run the
 * package's own `prepare` after installing. A cold-path dependency install
 * MUST therefore pass `--ignore-scripts` so it does not re-enter `prepare`
 * and recurse forever. That flag is the load-bearing recursion guard.
 *
 * This script runs BEFORE dist/ exists, so it is plain Node ESM and imports
 * nothing from dist/ and requires no compilation. Node floor: >=20.10.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The script lives in scripts/, so the repo root is its parent directory.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// POSIX path to the tsc shim that proves devDependencies are installed.
// v1 targets macOS/Linux; this is the correct probe on those platforms.
const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

// npm is `npm.cmd` on Windows; bare `npm` everywhere else (v1 = macOS/Linux).
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Build the child environment for the nested npm invocations.
 *
 * GLOBAL-INSTALL HAZARD: during `npm install -g .`, npm runs this package's
 * `prepare` lifecycle with `npm_config_global=true` exported into the
 * environment (npm's global-lifecycle context). A nested `npm ci` inherits
 * that flag and refuses with `ECIGLOBAL` ("`npm ci` does not work for global
 * packages") — so a bare `npm install -g .` on a clean checkout could not
 * self-bootstrap. We therefore DELETE `npm_config_global` (delete, not set to
 * "", because npm treats the key's mere presence as truthy) so the nested
 * `npm ci` runs as a LOCAL install in the repo root. Everything else
 * (registry, cache, auth, proxy, etc.) is inherited untouched so the nested
 * install behaves exactly like the developer's normal environment.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.npm_config_global;
  return env;
}

/**
 * Run a command, inheriting stdio, rooted at the repo. If it fails, propagate
 * the child's exit code (or 1) so `npm install -g .` fails loudly rather than
 * silently producing no dist/.
 */
function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: childEnv(),
  });
  if (result.error) {
    console.error(
      `prepare-bootstrap: failed to spawn \`${cmd} ${args.join(' ')}\`: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    console.error(
      `prepare-bootstrap: \`${cmd} ${args.join(' ')}\` terminated by signal ${result.signal}`,
    );
    process.exit(1);
  }
}

// COLD path: no node_modules/.bin/tsc → bootstrap deps once, then build.
// The single nested dependency install MUST carry --ignore-scripts so it does
// not re-run this `prepare` and recurse.
if (!existsSync(tscBin)) {
  run(npmCmd, ['ci', '--ignore-scripts']);
}

// Build invocation matches the existing build (`npm run build`, i.e.
// `tsc && tsc -p tsconfig.scripts.json`). WARM path reaches here directly.
run(npmCmd, ['run', 'build']);

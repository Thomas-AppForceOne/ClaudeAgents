#!/usr/bin/env node
/*
 * Postbuild bin-chmod helper.
 *
 * `tsc` emits the dist bin entrypoints (`dist/config-server/index.js`,
 * `dist/cli/index.js`) as mode 0644 — NOT executable. On the clean-checkout
 * install path the build runs via the package's `prepare` lifecycle, and
 * npm's own bin-chmod does not survive that prepare-time rebuild, so the
 * installed `gan` / `claudeagents-config-server` shims fail with exit 126
 * ("Permission denied"). This hook runs as `postbuild` after every
 * `npm run build`, adding the execute bits to every declared `package.json`
 * `bin` target so the built bins are runnable no matter how the build was
 * triggered (make build, install.sh's bootstrap, or prepare on a bare
 * `npm install -g .`).
 *
 * It runs right after the build, so it imports ONLY `node:` builtins — no
 * third-party dependency, nothing from `dist/`, no `require`. Node floor:
 * >=20.10, matching the rest of the toolchain.
 */
import { chmodSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The script lives in scripts/, so the package root is its parent directory
// (mirrors scripts/prepare-bootstrap.mjs).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const selfDerivedRoot = path.resolve(scriptDir, '..');

// TEST-ONLY root override: when `CAS_CHMOD_BINS_ROOT` is set and non-empty,
// use it as the package root instead of the self-derived one. This lets the
// Sprint 2 unit test point the hook at a hermetic fixture tree. When the env
// var is unset (production), behaviour is exactly the self-derived root.
const envRoot = process.env.CAS_CHMOD_BINS_ROOT;
const packageRoot = envRoot && envRoot.length > 0 ? path.resolve(envRoot) : selfDerivedRoot;

// Add the execute bits to every declared bin target, preserving its existing
// read/write bits. Reads the `bin` map from `<root>/package.json`.
const pkgPath = path.join(packageRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : {};

for (const relPath of Object.values(bin)) {
  const target = path.resolve(packageRoot, relPath);
  let mode;
  try {
    mode = statSync(target).mode;
  } catch (e) {
    // A declared bin target that is missing or unstattable is a real build
    // defect (the build did not emit the entrypoint). This message is
    // maintainer/build-tool-facing, not user-facing — keep it plain and
    // accurate, then exit non-zero so the broken build cannot pass silently.
    process.stderr.write(
      `chmod-bins: declared bin target is missing or unreadable: ${target} (${e.message})\n`,
    );
    process.exit(1);
  }
  // Idempotent: OR in the execute bits; re-running on an already-+x file is a
  // no-op (mode is unchanged).
  chmodSync(target, mode | 0o111);
}

process.exit(0);

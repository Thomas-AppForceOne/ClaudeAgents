/**
 * Locates the installed root of the `@claudeagents/config-server` package so
 * other modules can resolve package-bundled assets (the `package.json` for the
 * version, the built-in `stacks/` and `schemas/` directories) regardless of
 * where the process was launched from.
 *
 * The root is found by walking *up* from this module's own location until a
 * `package.json` named `@claudeagents/config-server` is found — robust to the
 * package being nested in `node_modules`, symlinked, or run from source.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Process-lifetime memo of the resolved root. The directory cannot move while
// the process runs, so the (potentially multi-`stat`) walk is done at most once.
let cached: string | undefined;

/**
 * Resolve the absolute path of the package root.
 *
 * Resolution order: an explicit `GAN_PACKAGE_ROOT_OVERRIDE` env var (used by
 * tests to point at a fixture install) wins outright; otherwise the memoised
 * value, if any; otherwise a fresh upward walk from this file.
 *
 * @returns the absolute directory containing the config-server `package.json`.
 * @throws a plain `Error` if the walk reaches the filesystem root without
 *   finding the package's `package.json` (the install is broken/missing).
 *   A malformed `package.json` encountered mid-walk is *not* fatal — it is
 *   skipped and the walk continues.
 *
 * Side effect: populates the module-level cache on the first non-override hit;
 * the override path is intentionally never cached, so toggling the env var
 * between calls is honoured.
 */
export function packageRoot(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  if (override !== undefined && override.length > 0) return override;
  if (cached !== undefined) return cached;
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@claudeagents/config-server') {
          cached = dir;
          return cached;
        }
      } catch {
        // Malformed package.json — keep walking.
      }
    }
    const parent = path.dirname(dir);
    // `path.dirname` of the filesystem root returns the root itself; that
    // fixed point is the loop's termination guard against an infinite walk.
    if (parent === dir) {
      throw new Error(
        `packageRoot(): could not locate @claudeagents/config-server's package.json by walking up from ${here}`,
      );
    }
    dir = parent;
  }
}

/**
 * Clear the memoised package root. Test-only seam (note the `_` prefix): a
 * test that mutates `GAN_PACKAGE_ROOT_OVERRIDE` or the on-disk layout calls
 * this so the next {@link packageRoot} invocation re-walks instead of
 * returning a stale cached value. No effect in production.
 */
export function _resetPackageRootCacheForTests(): void {
  cached = undefined;
}

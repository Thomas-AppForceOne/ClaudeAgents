import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Returns the absolute path to the directory containing this package's
 * package.json (`@claudeagents/config-server`). Cached after first call.
 *
 * Walks up from `import.meta.url` looking for the nearest ancestor
 * directory whose package.json declares `name === '@claudeagents/config-server'`.
 * Defends against monorepo parent package.json files at higher directories.
 *
 * @internal test-only env var: `GAN_PACKAGE_ROOT_OVERRIDE`. When set, it
 * takes precedence over the import.meta.url walk and over the cached
 * value, so tests can isolate the built-in tier from the framework's
 * own `<repoRoot>/stacks/` directory without changing every callsite to
 * pass `packageRoot:` explicitly. Mirrors the pattern in the CLI
 * commands (`stacks-customize`, `stacks-available`, `stacks-where`).
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
    if (parent === dir) {
      throw new Error(
        `packageRoot(): could not locate @claudeagents/config-server's package.json by walking up from ${here}`,
      );
    }
    dir = parent;
  }
}

/** For tests only: clears the cache. */
export function _resetPackageRootCacheForTests(): void {
  cached = undefined;
}

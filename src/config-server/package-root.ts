import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

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

export function _resetPackageRootCacheForTests(): void {
  cached = undefined;
}

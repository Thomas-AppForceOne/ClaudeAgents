// Global vitest setup file. It runs once before the suite and exists to make
// every test hermetic against the installed-package root: by default, stack
// resolution would discover the *real* repo's `stacks/` directory and let its
// built-in stacks bleed into tests. To prevent that, we redirect the package
// root to an empty temp directory so tests see no built-in stacks unless they
// explicitly seed their own fixture.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Honour an override the harness or an individual test may already have set —
// only install the empty-root default when nobody has chosen a package root.
if (process.env.GAN_PACKAGE_ROOT_OVERRIDE === undefined) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const realPackageJson = path.join(repoRoot, 'package.json');

  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'cas-tests-empty-package-root-'));
  // Copy the real package.json into the fake root so package-root discovery
  // (which keys off package.json) still recognises this directory as a valid
  // root — it is just one with an empty (absent) `stacks/` directory.
  if (existsSync(realPackageJson)) {
    copyFileSync(realPackageJson, path.join(fakeRoot, 'package.json'));
  } else {
    // Defensive fallback: mkdtempSync already created the dir, so this only
    // matters if the real package.json is somehow missing — keep the root valid.
    mkdirSync(fakeRoot, { recursive: true });
  }

  process.env.GAN_PACKAGE_ROOT_OVERRIDE = fakeRoot;
}

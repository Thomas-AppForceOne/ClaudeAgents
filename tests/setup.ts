
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

    mkdirSync(fakeRoot, { recursive: true });
  }

  process.env.GAN_PACKAGE_ROOT_OVERRIDE = fakeRoot;
}

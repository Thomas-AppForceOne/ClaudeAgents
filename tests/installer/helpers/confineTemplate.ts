/**
 * Renders the confinement-hook template exactly as `install.sh` would, so the
 * F7 suites can assert the on-disk hook is byte-identical to what ships.
 *
 * The shipped `gan-confine.sh` is produced from a versioned template in which
 * the literal `__GAN_FRAMEWORK_VERSION__` placeholder is substituted with the
 * package's current version. This helper reproduces that one substitution from
 * the repo's own `package.json`, giving tests a single source of truth for
 * "the artifact the installer should have written" without re-running the
 * installer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRootDir } from './spawn.js';

/**
 * Produce the version-substituted confinement-hook script.
 *
 * Reads the framework version from `package.json` and the raw hook template
 * from `scripts/hooks/gan-confine.sh.template`, then replaces every
 * `__GAN_FRAMEWORK_VERSION__` occurrence with that version (a global
 * split/join, not a single replace, since the placeholder may appear more than
 * once).
 *
 * @returns the fully-rendered hook source, identical to what `install.sh`
 *   writes to `~/.claude/hooks/gan-confine.sh`.
 */
export function renderedTemplate(): string {
  const root = repoRootDir();
  const version = (
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const tpl = readFileSync(
    path.join(root, 'scripts', 'hooks', 'gan-confine.sh.template'),
    'utf8',
  );
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(version);
}

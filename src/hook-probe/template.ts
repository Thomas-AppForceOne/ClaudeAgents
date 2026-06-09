/**
 * Canonical renderer for the framework's confinement-hook template.
 *
 * The template lives at `<packageRoot>/scripts/hooks/gan-confine.sh
 * .template` with `__GAN_FRAMEWORK_VERSION__` placeholders the
 * installer substitutes at install time. This module is the single
 * Node-side renderer: `install.sh` writes the user-tier hook from
 * the same template via shell substitution, and `gan hooks migrate
 * --replace` writes the project-tier hook from the same template via
 * this function. Co-locating the substitution logic here gives
 * `tests/hook-probe/template.test.ts` one symbol to assert
 * byte-equivalence against.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../config-server/package-root.js';

/**
 * Read the installed framework version from `<packageRoot>/package
 * .json`. Returns `null` when the file is absent, unreadable, has
 * malformed JSON, or carries no string `version` field — the
 * `unparseable`/`installedUnknown` branches in `compareBanner`
 * surface those cases as their own verdicts so callers needing a
 * non-null version can either throw (see {@link
 * readInstalledFrameworkVersionOrThrow}) or default-allow.
 *
 * @returns the parsed string `version`, or `null` on any failure mode.
 */
export function readInstalledFrameworkVersion(): string | null {
  const root = packageRoot();
  try {
    const raw = readFileSync(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Throwing variant of {@link readInstalledFrameworkVersion}.
 * `gan hooks migrate --replace` substitutes the version into the
 * template's banner line; rendering a banner without a version
 * would produce the literal string `undefined` (or `null`) on the
 * first line of every operator's hook, which is exactly the kind
 * of file `gan hooks status` is meant to flag. The throw makes the
 * `--replace` path fail closed instead.
 *
 * @returns the parsed string `version`.
 * @throws a plain `Error` when the underlying read returned `null`.
 */
export function readInstalledFrameworkVersionOrThrow(): string {
  const v = readInstalledFrameworkVersion();
  if (v === null) {
    throw new Error(
      `gan hooks migrate: framework's package.json has no string 'version' field`,
    );
  }
  return v;
}

/**
 * Read the framework's current rendered confinement-hook template.
 * Every occurrence of `__GAN_FRAMEWORK_VERSION__` is substituted
 * with the installed version (split/join so a multi-placeholder
 * template renders correctly). The return value is byte-identical
 * to what `install.sh` writes to the user-tier hook path — the
 * test at `tests/hook-probe/template.test.ts` pins this property
 * so a future `install.sh` change to the substitution rule cannot
 * silently drift from this renderer.
 *
 * @returns the rendered hook source as a UTF-8 string.
 * @throws when the package's `package.json` has no `version` field
 *   (the `--replace` path's fail-closed contract — see {@link
 *   readInstalledFrameworkVersionOrThrow}).
 */
export function renderCurrentTemplate(): string {
  const root = packageRoot();
  const templatePath = path.join(root, 'scripts', 'hooks', 'gan-confine.sh.template');
  const tpl = readFileSync(templatePath, 'utf8');
  const version = readInstalledFrameworkVersionOrThrow();
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(version);
}

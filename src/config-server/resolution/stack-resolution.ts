/**
 * Resolves a stack name to the concrete `.md` file that backs it, applying the
 * framework's tier precedence.
 *
 * The same stack name may be defined at several tiers; this module encodes the
 * single rule for which wins: project overrides user overrides built-in. That
 * ordering is the whole contract — it lets a project pin a customised stack
 * while still falling back to the packaged default.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';

/**
 * Which tier a resolved stack file came from, in precedence order:
 * `project` (in-repo override) > `user` (home-dir override) > `builtin`
 * (packaged default).
 */
export type StackTier = 'project' | 'user' | 'builtin';

/**
 * The outcome of resolving a stack name.
 *
 * @property path absolute path of the winning stack file.
 * @property tier which tier {@link path} was found in (records *why* this file
 *   won, which callers surface to the user).
 */
export interface StackResolution {

  path: string;

  tier: StackTier;
}

/**
 * Overrides for stack resolution; the production default `{}` derives both from
 * env/package layout.
 *
 * @property userHome home directory for the user tier; defaults to
 *   `GAN_USER_HOME`/`HOME`/`USERPROFILE` (see {@link resolveUserHome}).
 * @property packageRoot installed-package root for the built-in tier; defaults
 *   to {@link resolvePackageRoot}. Tests point this at a fixture install.
 */
export interface ResolveStackOptions {

  userHome?: string;

  packageRoot?: string;
}

/**
 * Resolve `name` to the highest-precedence stack file that exists.
 *
 * Search order (first hit wins): project (`<projectRoot>/.claude/gan/stacks`)
 * → user (`<userHome>/.claude/gan/stacks`, only if a home is resolvable) →
 * built-in package (`<packageRoot>/stacks`) → built-in fixture
 * (`<projectRoot>/stacks`). The fixture location is a test/source-tree
 * fallback for when the package is run from source rather than installed.
 *
 * @param name the stack name (the `.md` basename, without extension).
 * @param projectRoot the project directory anchoring the project and fixture
 *   tiers.
 * @param opts see {@link ResolveStackOptions}.
 * @returns the {@link StackResolution} for the winning tier.
 * @throws a `MissingFile` {@link ConfigServerError} when no tier has the file;
 *   its message lists every path probed so the user can see where to create it.
 */
export function resolveStackFile(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): StackResolution {
  const projectPath = path.join(projectRoot, '.claude', 'gan', 'stacks', `${name}.md`);
  if (existsSync(projectPath)) {
    return { path: projectPath, tier: 'project' };
  }

  // User tier is only consulted when a home directory is resolvable; an
  // unresolvable home simply skips this tier rather than erroring.
  const userHome = resolveUserHome(opts.userHome);
  const userPath = userHome ? path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`) : null;
  if (userPath && existsSync(userPath)) {
    return { path: userPath, tier: 'user' };
  }

  const pkgRoot = opts.packageRoot ?? resolvePackageRoot();
  const packageBuiltinPath = path.join(pkgRoot, 'stacks', `${name}.md`);
  if (existsSync(packageBuiltinPath)) {
    return { path: packageBuiltinPath, tier: 'builtin' };
  }

  // Fixture fallback: when running from a source/test tree the built-in stacks
  // live under the project root itself, not under an installed package root.
  const fixtureBuiltinPath = path.join(projectRoot, 'stacks', `${name}.md`);
  if (existsSync(fixtureBuiltinPath)) {
    return { path: fixtureBuiltinPath, tier: 'builtin' };
  }

  throw createError('MissingFile', {
    file: packageBuiltinPath,
    message: `Stack '${name}' not found in any tier (project: ${projectPath}; user: ${
      userPath ?? '<no user home>'
    }; built-in package: ${packageBuiltinPath}; built-in fixture: ${fixtureBuiltinPath}).`,
  });
}

// Resolve the user-tier home directory, preferring an explicit override, then
// the GAN-specific GAN_USER_HOME (lets a /gan run pin a hermetic home), then
// the OS HOME/USERPROFILE. Returns null when none yield a non-empty string, so
// the caller can skip the user tier entirely rather than build a bogus path.
function resolveUserHome(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

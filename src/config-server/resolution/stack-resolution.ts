

import { existsSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';

export type StackTier = 'project' | 'user' | 'builtin';

export interface StackResolution {

  path: string;

  tier: StackTier;
}

export interface ResolveStackOptions {

  userHome?: string;

  packageRoot?: string;
}

export function resolveStackFile(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): StackResolution {
  const projectPath = path.join(projectRoot, '.claude', 'gan', 'stacks', `${name}.md`);
  if (existsSync(projectPath)) {
    return { path: projectPath, tier: 'project' };
  }

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

function resolveUserHome(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

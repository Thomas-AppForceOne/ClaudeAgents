/**
 * C5 stack file resolver.
 *
 * Three-tier lookup, highest-priority wins (wholesale replacement, never
 * merge — see C5 invariants in PROJECT_CONTEXT.md):
 *
 *   1. project tier — `<projectRoot>/.claude/gan/stacks/<name>.md`
 *   2. user tier    — `<userHome>/.claude/gan/stacks/<name>.md`
 *   3. built-in tier — `<projectRoot>/stacks/<name>.md`
 *
 * The user tier is keyed by the caller-supplied `userHome` so tests can
 * substitute a temp directory rather than touching the real `~/.claude`. In
 * production callers leave it unset; the resolver falls back to
 * `process.env.HOME` (or `process.env.USERPROFILE` on Win32). For the
 * narrower CI use-case we additionally honour `GAN_USER_HOME` as an explicit
 * override env var so tests outside this package can target a fixture
 * without reaching into the resolver's API.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';

export type StackTier = 'project' | 'user' | 'builtin';

export interface StackResolution {
  /** Absolute path to the stack file that won resolution. */
  path: string;
  /** Which tier the resolved file came from. */
  tier: StackTier;
}

export interface ResolveStackOptions {
  /**
   * Override for the user-tier home directory. When set, the resolver looks
   * for the user-tier stack file under `<userHome>/.claude/gan/stacks/`. When
   * unset, falls back to `process.env.GAN_USER_HOME`, then `process.env.HOME`
   * / `process.env.USERPROFILE`.
   */
  userHome?: string;
}

/**
 * Resolve a stack file by name across the three C5 tiers.
 *
 * @throws ConfigServerError(MissingFile) when no tier carries the stack.
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

  const userHome = resolveUserHome(opts.userHome);
  if (userHome) {
    const userPath = path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`);
    if (existsSync(userPath)) {
      return { path: userPath, tier: 'user' };
    }
  }

  const builtinPath = path.join(projectRoot, 'stacks', `${name}.md`);
  if (existsSync(builtinPath)) {
    return { path: builtinPath, tier: 'builtin' };
  }

  throw createError('MissingFile', {
    file: builtinPath,
    message: `Stack '${name}' not found in any tier (project: ${projectPath}; user: ${
      userHome ? path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`) : '<no user home>'
    }; built-in: ${builtinPath}).`,
  });
}

function resolveUserHome(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

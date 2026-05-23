

/**
 * Resolution and validation of the project root every command operates on.
 *
 * The root comes either from an explicit `--project-root` flag or, when that is
 * absent, from the current working directory. This module turns that raw input
 * into a validated, canonicalised root once, so the rest of the CLI can assume
 * the directory exists and is canonical and never has to re-check.
 */

import { existsSync, statSync } from 'node:fs';

import {
  canonicalizePath,
  canonicalizePathForDisplay,
} from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';

/**
 * The validated project root, in two canonical forms.
 *
 * @property path the canonical absolute path, used as the key for resolution
 *   and caching (so symlinks/relative inputs collapse to one stable identity).
 * @property displayPath the canonical-for-display form, used in user-facing
 *   output where readability matters more than the canonical-for-keying form.
 * @property explicit `true` when the root came from a non-empty
 *   `--project-root` flag, `false` when it defaulted to the cwd; lets callers
 *   tailor messaging (e.g. "in the current directory" vs. the given path).
 */
export interface ResolvedProjectRoot {

  path: string;

  displayPath: string;

  explicit: boolean;
}

/**
 * Resolve, validate, and canonicalise the project root for a command.
 *
 * When `flag` is a non-empty string it is used as the root (and `explicit` is
 * `true`); otherwise the process cwd is used (`explicit` is `false`). The
 * chosen path is then checked to exist and to be a directory before being
 * canonicalised.
 *
 * @param flag the raw `--project-root` value, or `undefined` when not given.
 *   An empty string is treated as "not given" and falls back to the cwd.
 * @returns the {@link ResolvedProjectRoot} on success.
 * @throws a `MissingFile` `ConfigServerError` when the path does not exist, or
 *   a `MalformedInput` `ConfigServerError` when it exists but is not a
 *   directory. Both are thrown (not returned), so the caller's error path
 *   handles them; both carry the offending `path`.
 */
export function resolveProjectRoot(flag: string | undefined): ResolvedProjectRoot {
  // Treat an empty-string flag the same as an omitted one: only a non-empty
  // value counts as an explicit root, otherwise default to the cwd.
  const explicit = flag !== undefined && flag.length > 0;
  const raw = explicit ? flag! : process.cwd();
  if (!existsSync(raw)) {
    throw createError('MissingFile', {
      path: raw,
      message: `--project-root path does not exist: ${raw}`,
    });
  }
  const st = statSync(raw);
  if (!st.isDirectory()) {
    throw createError('MalformedInput', {
      path: raw,
      message: `--project-root path is not a directory: ${raw}`,
    });
  }
  return {
    path: canonicalizePath(raw),
    displayPath: canonicalizePathForDisplay(raw),
    explicit,
  };
}

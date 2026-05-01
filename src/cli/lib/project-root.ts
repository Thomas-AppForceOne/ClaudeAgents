/**
 * R3 sprint 1 — `--project-root` resolution.
 *
 * Defaults to the canonicalised form of `process.cwd()` per F3's path
 * canonicalisation rule. Centralised determinism lives in
 * `src/config-server/determinism/` (R1-locked); we import it directly
 * rather than reimplementing.
 *
 * Trust-mutating subcommands (R5) require `--project-root` explicitly;
 * R3 only surfaces the flag — the explicitness check sits in those
 * commands when they ship.
 */

import { existsSync, statSync } from 'node:fs';

import { canonicalizePath } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';

export interface ResolvedProjectRoot {
  /** Canonicalised path (per F3 determinism). */
  path: string;
  /** Whether `--project-root` was explicitly supplied. */
  explicit: boolean;
}

/**
 * Resolve a project-root value. If `flag` is undefined, falls back to
 * `process.cwd()`. The resulting path is canonicalised (symlinks resolved,
 * trailing slash stripped, lower-cased on Darwin/Win32 per F3's pin).
 *
 * Throws `Error` with a clear message if the path does not exist or is
 * not a directory. The dispatcher catches this and surfaces it via the
 * structured-error path with exit code 64.
 */
export function resolveProjectRoot(flag: string | undefined): ResolvedProjectRoot {
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
    explicit,
  };
}

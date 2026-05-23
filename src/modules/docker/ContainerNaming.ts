/**
 * ContainerNaming — derive a stable, Docker-safe container name from a
 * worktree path.
 *
 * A `/gan` run wants a container name that is both human-recognisable (so a
 * `docker ps` listing is readable) and collision-resistant (so two worktrees
 * whose basenames coincide do not fight over one container). The name this
 * module produces satisfies both: a sanitised, readable "core" taken from the
 * worktree's basename, plus a short hash suffix derived from the *canonical*
 * full path. Two distinct worktrees therefore always get distinct names even
 * when their last path segment is identical, and the same worktree always maps
 * to the same name (deterministic — the hash is over the canonical path, not
 * the raw input).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalizePath } from '../../config-server/determinism/index.js';

/**
 * Options bag for {@link nameForWorktree}. Currently empty (`Record<string,
 * never>`) — it exists so future knobs can be added without changing the
 * call signature.
 */
export type NameForWorktreeOptions = Record<string, never>;

/**
 * Build the Docker container name for a worktree.
 *
 * @param worktreePath the worktree's path; both its basename (for the readable
 *   core) and its canonical form (for the disambiguating hash) are used.
 * @param _options reserved for future use; currently ignored.
 * @returns `<sanitised-core>-<4-hex>`, deterministic for a given worktree.
 *
 * Determinism note: the hash is taken over {@link canonicalizePath} of the
 * input, so symlinked/relative spellings of the same worktree collapse to the
 * same suffix. The 4-hex (16-bit) suffix only disambiguates basename
 * collisions; it is not a cryptographic identifier.
 */
export function nameForWorktree(
  worktreePath: string,
  _options: NameForWorktreeOptions = {},
): string {

  // Prefer the basename for readability; fall back to the whole path when the
  // basename is empty (e.g. a trailing-slash root).
  const last = path.basename(worktreePath) || worktreePath;

  // Docker names are case-insensitive and restricted; lowercase first.
  let core = last.toLowerCase();

  // Replace any character outside the Docker-name-safe set with a hyphen.
  core = core.replace(/[^a-z0-9_.\-]/g, '-');

  // Collapse hyphen runs (from the substitution above) into a single hyphen.
  core = core.replace(/-+/g, '-');

  // Docker names must begin with an alphanumeric, so strip a leading
  // non-alphanumeric prefix.
  core = core.replace(/^[^a-z0-9]+/, '');

  // Suffix derives from the canonical path (not `core`) so basename collisions
  // disambiguate; first 4 hex chars are enough to separate worktrees readably.
  const canonical = canonicalizePath(worktreePath);
  const hex = createHash('sha256').update(canonical).digest('hex').slice(0, 4);

  return `${core}-${hex}`;
}

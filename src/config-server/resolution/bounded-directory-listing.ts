/**
 * A structure-only, scope-bounded view of a project's layout.
 *
 * The clarifier needs enough of the repository's shape to ground its questions
 * — which top-level areas exist, and which files the active stacks actually own
 * — WITHOUT ever reading file contents. This helper produces exactly that: the
 * project's top-level directory names plus the relative paths of files that
 * match the active stacks' scope globs. Two invariants make it safe to hand to
 * an agent:
 *
 *  - **Structure only.** It enumerates directory entries and stats them; it
 *    never opens a file or returns any byte of file content, so the listing
 *    cannot become a content-exfiltration channel.
 *  - **Scope-bounded.** Only paths matching at least one active-stack glob
 *    appear, so the clarifier cannot enumerate (and therefore cannot reason
 *    about) files the active stacks do not declare they own.
 *
 * It is also fault-tolerant: an unreadable or missing directory, or a stat
 * failure on a single entry, degrades to skipping that entry rather than
 * throwing, so a transiently-unreadable corner of the tree never aborts the
 * whole gather.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import picomatch from 'picomatch';

import { localeSort } from '../determinism/index.js';

/**
 * The bounded, structure-only listing handed to the clarifier.
 *
 * @property topLevelDirectories the names (not full paths) of the project
 *   root's immediate sub-directories, locale-sorted. These give the clarifier
 *   the coarse shape of the repo regardless of stack scope.
 * @property scopedFiles the relative POSIX paths (from the project root, no
 *   leading separator) of every file matching at least one active-stack scope
 *   glob, locale-sorted. A path outside every glob is absent by construction.
 */
export interface BoundedDirectoryListing {
  topLevelDirectories: string[];
  scopedFiles: string[];
}

// A defensive ceiling on traversal depth. Scope globs already bound the walk in
// practice (a glob like `src/**/*.ts` only justifies descending under `src`),
// but a pathologically deep or symlink-looped tree should still terminate, so
// the recursion carries an explicit depth cap rather than trusting the globs.
const MAX_WALK_DEPTH = 32;

/**
 * Build a {@link BoundedDirectoryListing} for `projectRoot`, including only file
 * paths that match the supplied active-stack `scopeGlobs`.
 *
 * @param projectRoot absolute path of the project root to enumerate. A
 *   non-existent or unreadable root yields an empty listing rather than an
 *   error.
 * @param scopeGlobs the active stacks' scope globs (e.g. `['**\/*.ts',
 *   '**\/*.tsx']`), matched against each file's project-relative POSIX path. An
 *   empty list matches no files, so `scopedFiles` comes back empty (only the
 *   top-level directory names are populated).
 * @returns a {@link BoundedDirectoryListing}; both arrays are locale-sorted for
 *   deterministic output.
 *
 * Never throws: every directory read and entry stat is guarded, and any I/O
 * fault degrades to skipping the offending entry. The function performs only
 * read-only directory enumeration and `stat` calls — it never reads file
 * contents, which is the property that lets the clarifier consume it safely.
 */
export function buildBoundedDirectoryListing(
  projectRoot: string,
  scopeGlobs: readonly string[],
): BoundedDirectoryListing {
  if (!existsSync(projectRoot)) {
    return { topLevelDirectories: [], scopedFiles: [] };
  }

  // Compile each glob once; matching is against project-relative POSIX paths.
  // `{ dot: true }` mirrors the surface-instantiation matcher so dot-prefixed
  // paths (e.g. config directories) participate rather than being silently
  // skipped — the clarifier should see them if a stack's scope claims them.
  const matchers = scopeGlobs.map((g) => picomatch(g, { dot: true }));
  const matchesScope = (relPosixPath: string): boolean =>
    matchers.some((isMatch) => isMatch(relPosixPath));

  const topLevelDirectories = listImmediateSubdirectories(projectRoot);

  const scopedFiles: string[] = [];
  walkForScopedFiles(projectRoot, projectRoot, 0, matchesScope, scopedFiles);

  return {
    topLevelDirectories: localeSort(topLevelDirectories),
    scopedFiles: localeSort(scopedFiles),
  };
}

// List the names of the immediate sub-directories of `dir`. Fault-tolerant: an
// unreadable directory yields `[]`, and a per-entry stat failure skips that
// entry, so a transient I/O problem never throws out of the gather.
function listImmediateSubdirectories(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of entries) {
    try {
      if (statSync(path.join(dir, name)).isDirectory()) names.push(name);
    } catch {
      // A stat failure on one entry (e.g. a broken symlink) is not fatal to the
      // listing; skip it and continue with the rest.
      continue;
    }
  }
  return names;
}

// Recursively collect project-relative POSIX paths of files matching the scope
// predicate, starting at `dir`. `depth` is the distance from the root and is
// capped by MAX_WALK_DEPTH so a symlink loop or pathological tree terminates.
// All reads are guarded: an unreadable directory or an un-stattable entry is
// skipped rather than thrown, mirroring the discovery walk in tools/validate.ts.
function walkForScopedFiles(
  projectRoot: string,
  dir: string,
  depth: number,
  matchesScope: (relPosixPath: string) => boolean,
  out: string[],
): void {
  if (depth > MAX_WALK_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    const full = path.join(dir, name);
    let isDirectory: boolean;
    let isFile: boolean;
    try {
      const st = statSync(full);
      isDirectory = st.isDirectory();
      isFile = st.isFile();
    } catch {
      // Skip an entry the framework cannot stat rather than aborting the walk.
      continue;
    }

    if (isDirectory) {
      walkForScopedFiles(projectRoot, full, depth + 1, matchesScope, out);
      continue;
    }
    if (!isFile) continue;

    // Globs are authored against forward-slash relative paths regardless of the
    // host separator, so normalise to POSIX before matching; this is also the
    // exact relative form recorded in the result so callers see stable paths.
    const relPosixPath = toPosixRelative(projectRoot, full);
    if (matchesScope(relPosixPath)) out.push(relPosixPath);
  }
}

// Convert an absolute path under `root` to a root-relative POSIX path (no
// leading separator), so glob matching and the emitted listing are platform
// independent and align with the spec's relative-POSIX path convention.
function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

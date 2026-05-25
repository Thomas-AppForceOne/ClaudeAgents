/**
 * A structure-only, scope-bounded view of a project's layout.
 *
 * The clarifier needs enough of the repository's shape to ground its questions
 * — which top-level areas exist, and which files the active stacks actually own
 * — WITHOUT ever reading file contents. This helper produces exactly that: the
 * project's top-level directory names plus the relative paths of files that
 * match the active stacks' scope globs. Three properties make it safe and
 * practical to hand to an agent:
 *
 *  - **Structure only.** It enumerates directory entries and stats them; it
 *    never opens a file or returns any byte of file content, so the listing
 *    cannot become a content-exfiltration channel.
 *  - **Scope-bounded.** Only paths matching at least one active-stack glob
 *    appear, so the clarifier cannot enumerate (and therefore cannot reason
 *    about) files the active stacks do not declare they own.
 *  - **Ignore-pruned.** The walk skips paths the project's own ignore file
 *    excludes (by default the repo-root `.gitignore`), and does not descend
 *    into an ignored directory at all. This is what keeps the walk bounded in
 *    practice: a scope glob rooted at a globstar legitimately matches files at
 *    any depth — including inside an installed-dependency or build-output tree
 *    — so without ignore-pruning the walk would traverse vendored and generated
 *    content the clarifier has no business reasoning about. Pruning is
 *    ecosystem-neutral: this module names no directory itself; it reads the
 *    patterns the project has already declared.
 *
 * It is also fault-tolerant: an unreadable or missing directory, or a stat
 * failure on a single entry, degrades to skipping that entry rather than
 * throwing, so a transiently-unreadable corner of the tree never aborts the
 * whole gather. {@link MAX_WALK_DEPTH} is the final backstop against a symlink
 * loop or a pathologically deep tree once ignore-pruning has done its work.
 *
 * The ignore syntax interpreted is a documented subset of gitignore (see
 * {@link gitignoreLineToGlobs}): blank lines and `#` comments are skipped, a
 * leading or embedded `/` anchors a pattern to the project root, a bare name
 * matches at any depth, and a trailing `/` directory marker is honoured as the
 * name. Negation (`!`) lines and nested per-directory ignore files are NOT
 * interpreted — over-pruning is harmless for a listing (it only removes paths),
 * so the subset errs toward exclusion rather than risk under-pruning.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import picomatch from 'picomatch';

import { localeSort } from '../determinism/index.js';

/**
 * The bounded, structure-only listing handed to the clarifier.
 *
 * @property topLevelDirectories the names (not full paths) of the project
 *   root's immediate, non-ignored sub-directories, locale-sorted. These give
 *   the clarifier the coarse shape of the repo regardless of stack scope.
 * @property scopedFiles the relative POSIX paths (from the project root, no
 *   leading separator) of every non-ignored file matching at least one
 *   active-stack scope glob, locale-sorted. A path outside every glob, or one
 *   the project's ignore file excludes, is absent by construction.
 */
export interface BoundedDirectoryListing {
  topLevelDirectories: string[];
  scopedFiles: string[];
}

/**
 * Options for {@link buildBoundedDirectoryListing}.
 *
 * @property ignoreGlobs picomatch patterns whose matches are pruned from both
 *   the walk and the result. When omitted, the project's repo-root `.gitignore`
 *   (if present) is read and translated into patterns; pass an explicit empty
 *   array to disable ignore-pruning entirely.
 */
export interface BoundedDirectoryListingOptions {
  ignoreGlobs?: readonly string[];
}

// A defensive ceiling on traversal depth. Ignore-pruning bounds the walk in
// practice (dependency and build trees are skipped before descent), but a
// pathologically deep or symlink-looped tree should still terminate, so the
// recursion carries an explicit depth cap as a last resort.
const MAX_WALK_DEPTH = 32;

/**
 * Build a {@link BoundedDirectoryListing} for `projectRoot`, including only file
 * paths that match the supplied active-stack `scopeGlobs` and are not excluded
 * by the resolved ignore patterns.
 *
 * @param projectRoot absolute path of the project root to enumerate. A
 *   non-existent or unreadable root yields an empty listing rather than an
 *   error.
 * @param scopeGlobs the active stacks' scope globs, matched against each file's
 *   project-relative POSIX path. An empty list matches no files, so
 *   `scopedFiles` comes back empty (only the top-level directory names are
 *   populated).
 * @param options see {@link BoundedDirectoryListingOptions}; controls
 *   ignore-pruning. Omitting it reads the project's `.gitignore`.
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
  options: BoundedDirectoryListingOptions = {},
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

  // An explicit ignore list wins; otherwise the project's own `.gitignore` is
  // the source, so pruning reflects what the project declares uninteresting
  // rather than any hardcoded, ecosystem-specific directory name.
  const ignoreGlobs = options.ignoreGlobs ?? readIgnoreGlobs(projectRoot);
  const ignoreMatchers = ignoreGlobs.map((g) => picomatch(g, { dot: true }));
  const isIgnored = (relPosixPath: string): boolean =>
    ignoreMatchers.some((isMatch) => isMatch(relPosixPath));

  const topLevelDirectories = listImmediateSubdirectories(projectRoot, isIgnored);

  const scopedFiles: string[] = [];
  walkForScopedFiles(projectRoot, projectRoot, 0, matchesScope, isIgnored, scopedFiles);

  return {
    topLevelDirectories: localeSort(topLevelDirectories),
    scopedFiles: localeSort(scopedFiles),
  };
}

/**
 * Read the project's repo-root `.gitignore` (if present) and translate it into
 * picomatch patterns for {@link buildBoundedDirectoryListing}'s ignore-pruning.
 *
 * @param projectRoot the directory whose `.gitignore` to read.
 * @returns the translated patterns, or an empty array when the file is absent
 *   or unreadable — a missing ignore file is the normal case, not an error.
 *
 * Never throws: a read failure degrades to an empty pattern set, which simply
 * disables pruning. See the module comment for the supported gitignore subset.
 */
export function readIgnoreGlobs(projectRoot: string): string[] {
  let content: string;
  try {
    content = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (const line of content.split('\n')) {
    globs.push(...gitignoreLineToGlobs(line));
  }
  return globs;
}

/**
 * Translate one `.gitignore` line into zero or more picomatch patterns.
 *
 * @param line a single raw line from a gitignore file.
 * @returns the patterns the line contributes: an empty array for a blank,
 *   comment, or negation line; a single root-anchored pattern when the line
 *   anchors to the project root (a leading or embedded `/`); or a single
 *   any-depth pattern for a bare name.
 *
 * Exported for unit testing. Implements the documented gitignore subset only:
 * it does not honour negation (`!`) or nested per-directory ignore files. A
 * trailing `/` directory marker is dropped because the listing treats a name
 * the same whether it resolves to a file or a directory.
 */
export function gitignoreLineToGlobs(line: string): string[] {
  const trimmed = line.trim();
  // A blank line and a comment are not patterns; a negation (un-ignore) is
  // deliberately unsupported — the subset errs toward exclusion.
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return [];

  let pattern = trimmed;
  // A trailing slash marks a directory-only rule; the listing treats a name the
  // same whether it is a file or a directory, so the marker is simply dropped.
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  // A leading or embedded slash anchors the rule to the project root; a bare
  // name (no slash) applies at any depth via a leading globstar.
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern === '') return [];
  return anchored ? [pattern] : [globstarPrefix(pattern)];
}

// Build an "at any depth" matcher for a bare name. Kept as a helper so the
// globstar string is assembled in code (where the `*` `*` `/` sequence is
// harmless) rather than written into a block comment, where it would close the
// comment early.
function globstarPrefix(name: string): string {
  return '**/' + name;
}

// List the names of the immediate, non-ignored sub-directories of `dir`.
// Fault-tolerant: an unreadable directory yields an empty list, and a per-entry
// stat failure skips that entry, so a transient I/O problem never throws out of
// the gather. An ignored top-level directory (a dependency or build-output
// tree the project declared) is dropped so the coarse shape shown to the agent
// is the project's own content, not its vendored or generated trees.
function listImmediateSubdirectories(
  dir: string,
  isIgnored: (relPosixPath: string) => boolean,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of entries) {
    // At the top level the entry name is already its project-relative path.
    if (isIgnored(name)) continue;
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

// Recursively collect project-relative POSIX paths of non-ignored files matching
// the scope predicate, starting at `dir`. `depth` is the distance from the root
// and is capped by MAX_WALK_DEPTH so a symlink loop or pathological tree
// terminates. All reads are guarded: an unreadable directory or an un-stattable
// entry is skipped rather than thrown, mirroring the discovery walk in
// tools/validate.ts. An ignored path is pruned BEFORE stat/descend, so an
// ignored directory is never walked — that pruning is what bounds a
// globstar-rooted scope glob from traversing vendored content.
function walkForScopedFiles(
  projectRoot: string,
  dir: string,
  depth: number,
  matchesScope: (relPosixPath: string) => boolean,
  isIgnored: (relPosixPath: string) => boolean,
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
    // Globs and ignore patterns are authored against forward-slash relative
    // paths regardless of the host separator, so normalise to POSIX before
    // matching; this is also the exact relative form recorded in the result so
    // callers see stable paths.
    const relPosixPath = toPosixRelative(projectRoot, full);

    // Prune anything the project's ignore rules exclude before stat/descend.
    if (isIgnored(relPosixPath)) continue;

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
      walkForScopedFiles(projectRoot, full, depth + 1, matchesScope, isIgnored, out);
      continue;
    }
    if (!isFile) continue;

    if (matchesScope(relPosixPath)) out.push(relPosixPath);
  }
}

// Convert an absolute path under `root` to a root-relative POSIX path (no
// leading separator), so glob matching and the emitted listing are platform
// independent and align with the spec's relative-POSIX path convention.
function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

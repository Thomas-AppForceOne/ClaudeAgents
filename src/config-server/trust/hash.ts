/**
 * Aggregate trust-hash computation for a project's `.claude/gan` config.
 *
 * The trust subsystem pins a single SHA-256 digest over every config file that
 * can influence command execution, so the framework can later detect whether
 * the approved-against contents have changed. This module computes that digest.
 *
 * The hash covers exactly: the project overlay (`project.md`), every `*.md`
 * stack file under `stacks/`, and every `*.yaml` module manifest under
 * `modules/`. Two properties make the digest reproducible and meaningful:
 * - **Determinism** — paths are canonicalised and locale-sorted before hashing,
 *   so directory-listing order and symlink spelling do not affect the result.
 * - **Content-only** — file *bytes* are hashed, not names or mtimes, so a
 *   rename that preserves contents and set membership yields the same digest.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';

/**
 * Result of {@link computeTrustHash}.
 *
 * @property aggregateHash the digest, prefixed with its algorithm
 *   (`sha256:<hex>`); the prefix lets a future algorithm change be told apart
 *   from a content change.
 * @property files the canonical, sorted list of files that fed the hash, in the
 *   exact order they were hashed — useful for diagnostics and for showing the
 *   user what an approval covers.
 */
export interface TrustHashResult {

  aggregateHash: string;

  files: string[];
}

/**
 * Compute the aggregate trust hash over a project's `.claude/gan` config files.
 *
 * Reads files from disk (no writes). A missing `.claude/gan` directory, or any
 * absent subdirectory, simply contributes nothing — the result is then the hash
 * of an empty input, not an error. The directory scans are fault-tolerant
 * (unreadable dirs are skipped), but the final `readFileSync` over a path that
 * passed the `isRegularFile` check is *not* guarded: if a file vanishes between
 * the stat and the read (a TOCTOU race) the underlying I/O error propagates.
 *
 * @param projectRoot the project directory whose `.claude/gan` tree is hashed;
 *   used to locate files only — it is not itself canonicalised here (each
 *   collected file path is canonicalised individually).
 * @returns the {@link TrustHashResult} (digest plus the ordered file list).
 */
export function computeTrustHash(projectRoot: string): TrustHashResult {
  const ganRoot = path.join(projectRoot, '.claude', 'gan');

  const pendingPaths: string[] = [];

  const projectOverlay = path.join(ganRoot, 'project.md');
  if (isRegularFile(projectOverlay)) {
    pendingPaths.push(projectOverlay);
  }

  const stacksDir = path.join(ganRoot, 'stacks');
  if (isDirectory(stacksDir)) {
    for (const name of safeReaddir(stacksDir)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(stacksDir, name);
      if (isRegularFile(full)) {
        pendingPaths.push(full);
      }
    }
  }

  const modulesDir = path.join(ganRoot, 'modules');
  if (isDirectory(modulesDir)) {
    for (const name of safeReaddir(modulesDir)) {
      if (!name.endsWith('.yaml')) continue;
      const full = path.join(modulesDir, name);
      if (isRegularFile(full)) {
        pendingPaths.push(full);
      }
    }
  }

  // Canonicalise then sort so the hash is independent of how the paths were
  // spelled and of the OS-dependent readdir order — this is what makes the
  // digest reproducible across machines.
  const canonicalised = pendingPaths.map((p) => canonicalizePath(p));
  const sorted = localeSort(canonicalised);

  const hash = createHash('sha256');
  for (const p of sorted) {
    hash.update(readFileSync(p));
  }
  // The `sha256:` prefix is part of the stored hash so a future algorithm
  // change is distinguishable from a content change.
  const aggregateHash = 'sha256:' + hash.digest('hex');

  return { aggregateHash, files: sorted };
}

/** True when `p` is an existing regular file; any stat error yields `false`. */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` is an existing directory; any stat error yields `false`. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List a directory's entries, returning `[]` instead of throwing when it cannot
 * be read. The caller has already confirmed the directory exists via
 * {@link isDirectory}, so an error here is an unusual condition (e.g. a
 * permission change between calls) that should degrade to "no files" rather
 * than abort the whole hash.
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

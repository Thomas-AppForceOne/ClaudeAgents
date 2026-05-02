/**
 * Deterministic SHA-256 aggregate hash over a project's trust-relevant
 * configuration files.
 *
 * Per F4/R5, trust is anchored to the content of the project's overlay and
 * adjacent declarative files. The trust cache compares a stored hash against
 * a recomputed hash to detect untrusted edits. This module owns the
 * recomputation: it enumerates a fixed, documented set of files under
 * `<projectRoot>/.claude/gan/`, canonicalises each path through F3's
 * `canonicalizePath`, sorts via F3's `localeSort`, and folds their bytes into
 * a single SHA-256 digest.
 *
 * Inputs (the only files considered):
 *  - `<projectRoot>/.claude/gan/project.md` — the project overlay (single file
 *    when present).
 *  - `<projectRoot>/.claude/gan/stacks/*.md` — direct children only; nested
 *    subdirectories are ignored.
 *  - `<projectRoot>/.claude/gan/modules/*.yaml` — direct children only; the
 *    `.yml` extension is intentionally excluded (manifests are `.yaml`).
 *
 * Missing files or directories simply contribute nothing — they are not an
 * error. An empty input set yields the SHA-256 of zero bytes:
 * `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *
 * Synchronous by design: the trust check runs early in the request path and
 * must be order-deterministic with no event-loop interleaving.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';

export interface TrustHashResult {
  /** `sha256:<64-hex>` digest of the concatenated bytes of `files`, in order. */
  aggregateHash: string;
  /** Canonical, locale-sorted absolute paths of every file that contributed. */
  files: string[];
}

/**
 * Compute the deterministic trust hash for `projectRoot`.
 *
 * The function never throws for missing files: any path that is absent or not
 * the expected file type is silently skipped, falling through to the empty
 * case if no inputs match. Read errors propagate (e.g. permission denied on a
 * file that exists), since those indicate a real environmental problem the
 * caller must surface.
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

  const canonicalised = pendingPaths.map((p) => canonicalizePath(p));
  const sorted = localeSort(canonicalised);

  const hash = createHash('sha256');
  for (const p of sorted) {
    hash.update(readFileSync(p));
  }
  const aggregateHash = 'sha256:' + hash.digest('hex');

  return { aggregateHash, files: sorted };
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

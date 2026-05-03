/**
 * ContainerNaming — deterministic, container-safe names derived from
 * worktree paths.
 *
 * **Algorithm (pinned).** Given a `worktreePath`:
 *
 *   1. Take the **last path segment** of `worktreePath`.
 *   2. **Lowercase** it.
 *   3. Replace any character outside `[a-z0-9_.-]` with `-`.
 *   4. **Collapse runs of `-`** into a single `-`.
 *   5. **Trim leading characters** until the first `[a-z0-9]`.
 *   6. Append `-<4-hex>` where `<4-hex>` is
 *      `crypto.createHash('sha256').update(<canonical worktree path>)
 *       .digest('hex').slice(0, 4)`.
 *
 * The canonical worktree path is computed via the project's central
 * canonicalisation helper (`canonicalizePath` from
 * `src/config-server/determinism/`). The hash is therefore stable across
 * symlinks and (on case-insensitive filesystems) case differences.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalizePath } from '../../config-server/determinism/index.js';

/**
 * Reserved for future knobs; v1 uses none. Kept on the signature so
 * callers compile without changes when knobs land. We use a record
 * type rather than an empty interface to satisfy the project's
 * `@typescript-eslint/no-empty-object-type` lint rule.
 */
export type NameForWorktreeOptions = Record<string, never>;

/**
 * Build the deterministic container name for `worktreePath`. See the
 * algorithm in the file-level doc comment — this is the single
 * implementation; do not duplicate the steps elsewhere.
 */
export function nameForWorktree(
  worktreePath: string,
  _options: NameForWorktreeOptions = {},
): string {
  // Step 1: last path segment.
  const last = path.basename(worktreePath) || worktreePath;
  // Step 2: lowercase.
  let core = last.toLowerCase();
  // Step 3: replace non-[a-z0-9_.-] with '-'.
  core = core.replace(/[^a-z0-9_.\-]/g, '-');
  // Step 4: collapse runs of '-' into a single '-'.
  core = core.replace(/-+/g, '-');
  // Step 5: trim leading characters until the first [a-z0-9].
  core = core.replace(/^[^a-z0-9]+/, '');

  // Step 6: append '-<4-hex>' from sha256(canonical worktree path).
  const canonical = canonicalizePath(worktreePath);
  const hex = createHash('sha256').update(canonical).digest('hex').slice(0, 4);

  return `${core}-${hex}`;
}

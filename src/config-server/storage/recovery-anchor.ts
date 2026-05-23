

/**
 * Guard that a run is recovered from the *same* worktree it originally ran in.
 *
 * A run's progress records the worktree path and branch it executed against
 * (its "anchor"). Recovery must happen from that exact worktree, because the
 * run's commits and uncommitted state live there — recovering from elsewhere
 * would operate on the wrong tree. This module compares the caller's current
 * directory to the recorded anchor and refuses (with actionable guidance) when
 * they diverge or the recorded worktree is gone. The run's data itself is safe
 * in the central store regardless; only the worktree-bound recovery is gated.
 */
import { existsSync } from 'node:fs';

import { canonicalizePath, canonicalizePathForDisplay } from '../determinism/index.js';

/**
 * The worktree identity a run was anchored to, read back from its progress.
 *
 * @property worktreePath the worktree the run executed in (as recorded).
 * @property branch the branch checked out in that worktree.
 */
export interface WorkspaceAnchor {

  worktreePath: string;

  branch: string;
}

/**
 * Outcome of an anchor check.
 *
 * @property ok `true` when recovery may proceed from the current location.
 * @property refusal why recovery is refused (only on `ok: false`):
 *   `missing-worktree` (the recorded worktree no longer exists) or
 *   `wrong-worktree` (the caller is in a different worktree).
 * @property message human-readable explanation with remediation (only on
 *   `ok: false`).
 */
export interface RecoveryAnchorResult {

  ok: boolean;

  refusal?: 'wrong-worktree' | 'missing-worktree';

  message?: string;
}

/**
 * Inputs to {@link checkRecoveryAnchor}.
 *
 * @property runId the run being recovered, used in messages.
 * @property workspace the recorded anchor to check against.
 * @property fromDir the directory recovery is being attempted from; defaults to
 *   `process.cwd()`.
 * @property worktreeExists existence probe for the recorded worktree path;
 *   defaults to `fs.existsSync`. Injected in tests to simulate a missing tree.
 */
export interface CheckRecoveryAnchorOptions {

  runId: string;

  workspace: WorkspaceAnchor;

  fromDir?: string;

  worktreeExists?: (p: string) => boolean;
}

/**
 * Decide whether a run may be recovered from the current location.
 *
 * Comparison is by *canonical* path (symlinks/case normalised) so that an
 * equivalent path spelled differently still matches; the *display* form is used
 * in messages so the user sees a readable path. The existence check runs first:
 * a recorded worktree that is gone yields `missing-worktree` (recreate it),
 * otherwise a path mismatch yields `wrong-worktree` (cd there).
 *
 * @param opts see {@link CheckRecoveryAnchorOptions}.
 * @returns a {@link RecoveryAnchorResult}; pure (aside from the injected
 *   existence probe) and never throws.
 */
export function checkRecoveryAnchor(opts: CheckRecoveryAnchorOptions): RecoveryAnchorResult {
  const worktreeExists = opts.worktreeExists ?? existsSync;
  const recordedCanonical = canonicalizePath(opts.workspace.worktreePath);
  const recordedDisplay = canonicalizePathForDisplay(opts.workspace.worktreePath);
  const branch = opts.workspace.branch;

  if (!worktreeExists(opts.workspace.worktreePath)) {
    return {
      ok: false,
      refusal: 'missing-worktree',
      message:
        `Run ${opts.runId} was executed in worktree ${recordedDisplay} (branch ${branch}), ` +
        `but that worktree no longer exists. Recreate it (git worktree add ${recordedDisplay} ` +
        `${branch}) and recover from there. The run data is safe in the central store.`,
    };
  }

  const current = opts.fromDir ?? process.cwd();
  const currentCanonical = canonicalizePath(current);
  if (currentCanonical === recordedCanonical) {
    return { ok: true };
  }

  return {
    ok: false,
    refusal: 'wrong-worktree',
    message:
      `Run ${opts.runId} was executed in worktree ${recordedDisplay} (branch ${branch}); ` +
      `recover it from there.`,
  };
}

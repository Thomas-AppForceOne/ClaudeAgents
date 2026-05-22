/**
 * F7 slice 4 — recovery worktree-anchor guard (over O2 §5 / §1).
 *
 * A run's data is discoverable repo-wide (any worktree can enumerate it via the
 * central store — see {@link enumerateRuns}), but RESUMING a run is bound to the
 * one worktree it executed in: its working tree, branch, and base commit live
 * there. `--recover` therefore refuses when the current invocation is not the
 * run's recorded `workspace.worktreePath`, exiting non-zero with the documented
 * message (F7 spec §4):
 *
 *   `Run <id> was executed in worktree <path> (branch <branch>); recover it
 *    from there.`
 *
 * If the recorded worktree no longer exists (it was removed), recovery refuses
 * with the same path plus guidance to recreate it — the run *data* is safe in
 * the central store, but the worktree it must resume into is gone.
 *
 * Determinism: the comparison is canonical and boundary-correct. The current
 * invocation's worktree and the recorded `workspace.worktreePath` are BOTH
 * canonicalised through the centralised determinism module
 * ({@link canonicalizePath}) before equality, so a path differing only by a
 * trailing slash or (on darwin/win32) letter case is treated as the SAME
 * worktree — no spurious refusal. This module never re-implements
 * realpath / case-folding / slash-stripping; it imports the single pinned
 * implementation. For the user-visible message it renders the recorded path via
 * {@link canonicalizePathForDisplay} (case-preserving) so macOS users see their
 * real `/Users/...` casing.
 *
 * The guard reads only the supplied progress record (already parsed by the
 * enumerator) and probes the recorded worktree path for existence; it never
 * reads or writes the module-state store, `.claude/gan/`, or `.gan-cache/`.
 */

import { existsSync } from 'node:fs';

import { canonicalizePath, canonicalizePathForDisplay } from '../determinism/index.js';

/** The minimal workspace fields the guard needs from `progress.json`. */
export interface WorkspaceAnchor {
  /** The canonical absolute worktree path recorded at run start. */
  worktreePath: string;
  /** The branch the run executes on. */
  branch: string;
}

/** Outcome of {@link checkRecoveryAnchor}. */
export interface RecoveryAnchorResult {
  /** `true` when recovery may proceed (the cwd IS the recorded worktree). */
  ok: boolean;
  /**
   * Why recovery was refused, when `ok` is `false`:
   *   - `wrong-worktree` — the cwd is a different (existing) worktree.
   *   - `missing-worktree` — the recorded worktree no longer exists on disk.
   */
  refusal?: 'wrong-worktree' | 'missing-worktree';
  /** The user-facing refusal message (set only when `ok` is `false`). */
  message?: string;
}

/** Options for {@link checkRecoveryAnchor}. */
export interface CheckRecoveryAnchorOptions {
  /** The run id (named in the refusal message). */
  runId: string;
  /** The recorded `workspace` block from `progress.json`. */
  workspace: WorkspaceAnchor;
  /** The current invocation's worktree directory. Defaults to `process.cwd()`. */
  fromDir?: string;
  /**
   * Existence probe for the recorded worktree path. Defaults to `fs.existsSync`.
   * Injected in tests so the missing-worktree branch is exercisable without
   * mutating the filesystem.
   */
  worktreeExists?: (p: string) => boolean;
}

/**
 * Guard `--recover` against being run from the wrong worktree.
 *
 * Returns `{ ok: true }` when the current invocation's worktree canonically
 * equals the recorded `workspace.worktreePath`. Otherwise returns
 * `{ ok: false, refusal, message }` — `wrong-worktree` when the cwd is a
 * genuinely different worktree, or `missing-worktree` when the recorded
 * worktree no longer exists on disk (checked first, since a removed worktree
 * cannot be the cwd anyway).
 *
 * This function is side-effect-free: it neither exits the process nor mutates
 * any file. The caller (SKILL.md orchestrator) maps a non-`ok` result to a
 * non-zero exit and prints `message`.
 */
export function checkRecoveryAnchor(opts: CheckRecoveryAnchorOptions): RecoveryAnchorResult {
  const worktreeExists = opts.worktreeExists ?? existsSync;
  const recordedCanonical = canonicalizePath(opts.workspace.worktreePath);
  const recordedDisplay = canonicalizePathForDisplay(opts.workspace.worktreePath);
  const branch = opts.workspace.branch;

  // If the recorded worktree is gone, recovery cannot resume there regardless
  // of where it is invoked from. Refuse with recreate guidance.
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

/**
 * F7 slice 4 — merge-aware `--cleanup` planner + executor, re-anchored to the
 * central store (over O2 §5.5).
 *
 * `--cleanup` ALWAYS deletes the central-store run directory
 * (`<store-root>/<repo-key>/runs/<run-id>/`) for every confirmed target — that
 * is the source-of-truth artifact removal, and its failure is the only step
 * that escalates to a non-zero batch exit (other per-run steps warn and
 * continue).
 *
 * Workspace handling depends on `workspace.createdByGan`:
 *
 *   - **gan-created (cases 1b/1c, `createdByGan === true`)** — remove the
 *     run-scoped worktree, then handle the task branch BY MERGE STATUS:
 *       * MERGED into its base/upstream -> delete locally (`git branch -D`) and,
 *         when a tracking branch exists, on the remote
 *         (`git push <remote> --delete <branch>`).
 *       * NOT merged -> WARN (naming the branch) and do NOT delete it without
 *         `--yes`/confirmation.
 *     The merge check ALWAYS runs BEFORE any deletion (no unconditional
 *     `git branch -D`).
 *   - **user-owned (case 1a, `createdByGan === false`)** — the worktree and
 *     branch are NEVER touched: only the central-store run dir is removed.
 *
 * Active-run guard: cleanup reads the central-store `run.lock`; if a target's
 * run id matches the lock's `runId` AND the holder pid is alive, cleanup
 * refuses (non-zero) naming the run id and pid — nothing is removed. A stale
 * lock (dead pid) is ignored.
 *
 * Subprocess safety (`shell_and_subprocess_safety`). The run-id, branch name,
 * base branch, worktree path, and remote name all trace to user-controlled
 * input and are UNTRUSTED. Every git invocation goes through the injectable
 * {@link GitExec} seam with an ARGV ARRAY (`execFileSync`, never a shell string,
 * never the shell-spawning option), so a value containing shell metacharacters
 * reaches git as ONE literal argument with no expansion. The destructive
 * branch deletes are gated on the prior merge-status check; the recorded argv
 * order proves merge-status precedes any `branch -D` / `push --delete`.
 *
 * Zone safety: the only filesystem write is the central-store run-dir deletion
 * (delegated to an injectable {@link RmDir} seam, defaulting to
 * `fs.rmSync(..., { recursive, force })`); nothing here reads or writes the
 * module-state store, `.claude/gan/`, or `.gan-cache/`.
 */

import { rmSync } from 'node:fs';

import { canonicalizePathForDisplay } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { EnumeratedRun } from './run-enumerator.js';
import { readRunLock, defaultIsAlive, type IsAlive } from './run-lock.js';
import { defaultGitExec, resolveDefaultBranch, type GitExec } from './worktree-resolver.js';

/** Recursive directory removal seam (tests). Defaults to `fs.rmSync`. */
export type RmDir = (dir: string) => void;

/** Default directory-removal seam: `fs.rmSync(dir, { recursive, force })`. */
export const defaultRmDir: RmDir = (dir) => rmSync(dir, { recursive: true, force: true });

/** How a target's branch should be handled, decided BEFORE any deletion. */
export type BranchPlan =
  | { kind: 'none'; reason: 'user-owned' | 'no-branch' }
  | { kind: 'delete-merged'; branch: string; remote?: string }
  | { kind: 'warn-unmerged'; branch: string };

/** The plan for a single run, computed before any side effect. */
export interface RunCleanupPlan {
  /** The run id. */
  runId: string;
  /** The central-store run dir to remove (always). */
  runDir: string;
  /** Whether gan created the workspace (1b/1c) vs the user owns it (1a). */
  createdByGan: boolean;
  /** The gan-created worktree to remove, when `createdByGan` is true. */
  worktreePath?: string;
  /** How the branch is handled (merge status decided here, before deletes). */
  branchPlan: BranchPlan;
}

/** Per-run execution outcome. */
export interface RunCleanupOutcome {
  runId: string;
  /** `true` when the central-store run dir was removed. */
  runDirRemoved: boolean;
  /** `true` when the run-scoped worktree was removed. */
  worktreeRemoved: boolean;
  /** `true` when the local branch was deleted. */
  branchDeletedLocal: boolean;
  /** `true` when the remote branch was deleted. */
  branchDeletedRemote: boolean;
  /** Non-fatal warnings raised for this run (e.g. unmerged branch, step failure). */
  warnings: string[];
}

/** Options shared by the planner and executor. */
export interface CleanupOptions {
  /** Injectable git seam; defaults to {@link defaultGitExec}. */
  git?: GitExec;
  /** Directory the git commands run from (the main checkout). */
  fromDir: string;
  /** Remote name for the remote-delete. Defaults to `origin`. */
  remote?: string;
}

// ---- merge-status (always evaluated BEFORE any delete) --------------------

/**
 * Resolve the base ref a branch is checked for merge against:
 * the run's recorded `baseBranch` when present, else the slice-2
 * {@link resolveDefaultBranch} (origin/HEAD -> init.defaultBranch ->
 * develop/main/master), else `undefined`.
 */
export function resolveMergeBase(
  git: GitExec,
  fromDir: string,
  run: EnumeratedRun,
): string | undefined {
  if (typeof run.baseBranch === 'string' && run.baseBranch.length > 0) return run.baseBranch;
  return resolveDefaultBranch(git, fromDir);
}

/**
 * `true` when `branch`'s tip is an ancestor of `base` OR its upstream
 * (`@{upstream}`) — i.e. the branch is MERGED. Uses
 * `git merge-base --is-ancestor <branch> <ref>` (exit 0 = ancestor); the seam
 * surfaces a non-zero exit as a throw, which we map to `false`. The branch and
 * every ref are passed as discrete argv elements, never interpolated into a
 * shell line.
 */
export function isBranchMerged(
  git: GitExec,
  fromDir: string,
  branch: string,
  base: string | undefined,
): boolean {
  const refs: string[] = [];
  if (base !== undefined && base.length > 0) refs.push(base);
  // Consult an upstream tracking ref when one is configured for the branch.
  try {
    const upstream = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], fromDir).trim();
    if (upstream.length > 0) refs.push(upstream);
  } catch {
    // No upstream configured; only the base ref is consulted.
  }

  for (const ref of refs) {
    try {
      // Exit 0 => branch tip IS an ancestor of ref => merged.
      git(['merge-base', '--is-ancestor', branch, ref], fromDir);
      return true;
    } catch {
      // Non-zero => not an ancestor of this ref; try the next.
    }
  }
  return false;
}

/** `true` when `branch` has a configured upstream tracking ref. */
function hasUpstream(git: GitExec, fromDir: string, branch: string): boolean {
  try {
    const out = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], fromDir).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// ---- planning (no side effects) -------------------------------------------

/**
 * Plan cleanup for a single run WITHOUT performing any side effect. Classifies
 * the workspace and — for a gan-created branch — evaluates merge status now, so
 * the destructive decision is made strictly before any delete is issued.
 */
export function planRunCleanup(run: EnumeratedRun, opts: CleanupOptions): RunCleanupPlan {
  const git = opts.git ?? defaultGitExec;
  const remote = opts.remote ?? 'origin';
  const createdByGan = run.workspace?.createdByGan === true;

  if (!createdByGan) {
    // Case 1a: never touch the user's worktree or branch.
    return {
      runId: run.runId,
      runDir: run.runDir,
      createdByGan: false,
      branchPlan: { kind: 'none', reason: 'user-owned' },
    };
  }

  const worktreePath = run.workspace?.worktreePath;
  const branch = run.workspace?.branch ?? run.runBranch;
  if (branch === undefined || branch.length === 0) {
    return {
      runId: run.runId,
      runDir: run.runDir,
      createdByGan: true,
      worktreePath,
      branchPlan: { kind: 'none', reason: 'no-branch' },
    };
  }

  // Merge check FIRST — before the executor issues any delete.
  const base = resolveMergeBase(git, opts.fromDir, run);
  const merged = isBranchMerged(git, opts.fromDir, branch, base);

  if (!merged) {
    return {
      runId: run.runId,
      runDir: run.runDir,
      createdByGan: true,
      worktreePath,
      branchPlan: { kind: 'warn-unmerged', branch },
    };
  }

  const branchPlan: BranchPlan = { kind: 'delete-merged', branch };
  if (hasUpstream(git, opts.fromDir, branch)) branchPlan.remote = remote;
  return {
    runId: run.runId,
    runDir: run.runDir,
    createdByGan: true,
    worktreePath,
    branchPlan,
  };
}

// ---- execution ------------------------------------------------------------

/** Options for {@link executeRunCleanup}. */
export interface ExecuteCleanupOptions extends CleanupOptions {
  /** Confirmation gate: an unmerged branch is deleted only when this is true. */
  yes?: boolean;
  /** Directory-removal seam; defaults to {@link defaultRmDir}. */
  rmDir?: RmDir;
  /** Warning sink; defaults to `console.error`. */
  warn?: (line: string) => void;
}

/**
 * Execute a previously-computed {@link RunCleanupPlan}. Order of operations:
 *
 *   1. Remove the run-scoped worktree (gan-created only) — best-effort.
 *   2. Handle the branch per the plan (merge status was decided in planning,
 *      strictly before this point):
 *        - `delete-merged` -> `git branch -D` locally, then
 *          `git push <remote> --delete <branch>` when a remote was planned.
 *        - `warn-unmerged` -> warn naming the branch; delete only when
 *          `yes === true` (then warn + delete); otherwise leave it.
 *        - `none` -> touch nothing (user-owned or no branch).
 *   3. ALWAYS remove the central-store run dir. A failure here is the only
 *      step that throws (escalating to a non-zero batch exit); every other
 *      step warns and continues.
 *
 * Returns a {@link RunCleanupOutcome} describing what happened.
 *
 * @throws ConfigServerError when the central-store run-dir removal fails.
 */
export function executeRunCleanup(
  plan: RunCleanupPlan,
  opts: ExecuteCleanupOptions,
): RunCleanupOutcome {
  const git = opts.git ?? defaultGitExec;
  const rmDir = opts.rmDir ?? defaultRmDir;
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const outcome: RunCleanupOutcome = {
    runId: plan.runId,
    runDirRemoved: false,
    worktreeRemoved: false,
    branchDeletedLocal: false,
    branchDeletedRemote: false,
    warnings: [],
  };

  // 1. Remove the gan-created worktree (best-effort).
  if (plan.createdByGan && plan.worktreePath !== undefined) {
    try {
      git(['worktree', 'remove', '--force', plan.worktreePath], opts.fromDir);
      outcome.worktreeRemoved = true;
    } catch {
      const w = `Run ${plan.runId}: could not remove worktree ${plan.worktreePath}; continuing.`;
      outcome.warnings.push(w);
      warn(w);
    }
  }

  // 2. Branch handling (merge status already decided in the plan).
  handleBranch(plan, opts, git, warn, outcome);

  // 3. ALWAYS remove the central-store run dir. Failure escalates.
  try {
    rmDir(plan.runDir);
    outcome.runDirRemoved = true;
  } catch (e) {
    throw createError('MalformedInput', {
      path: plan.runDir,
      field: 'runDir',
      message:
        `The framework could not remove the run directory ${plan.runDir} during cleanup: ` +
        `${e instanceof Error ? e.message : String(e)}.`,
    });
  }

  return outcome;
}

function handleBranch(
  plan: RunCleanupPlan,
  opts: ExecuteCleanupOptions,
  git: GitExec,
  warn: (line: string) => void,
  outcome: RunCleanupOutcome,
): void {
  const bp = plan.branchPlan;
  if (bp.kind === 'none') return;

  if (bp.kind === 'delete-merged') {
    deleteBranchLocalAndRemote(bp.branch, bp.remote, opts, git, warn, outcome);
    return;
  }

  // warn-unmerged: always warn naming the branch.
  const line =
    `Run ${plan.runId}: branch '${bp.branch}' is not merged into its base/upstream; ` +
    `its commits would be lost if deleted.`;
  outcome.warnings.push(line);
  warn(line);
  if (opts.yes === true) {
    // The user explicitly confirmed; delete the unmerged branch.
    warn(`Run ${plan.runId}: deleting unmerged branch '${bp.branch}' (--yes given).`);
    deleteBranchLocalAndRemote(bp.branch, undefined, opts, git, warn, outcome);
  }
  // Without --yes: leave the branch in place (no delete argv issued).
}

function deleteBranchLocalAndRemote(
  branch: string,
  remote: string | undefined,
  opts: ExecuteCleanupOptions,
  git: GitExec,
  warn: (line: string) => void,
  outcome: RunCleanupOutcome,
): void {
  try {
    git(['branch', '-D', branch], opts.fromDir);
    outcome.branchDeletedLocal = true;
  } catch {
    const w = `Could not delete local branch '${branch}'; continuing.`;
    outcome.warnings.push(w);
    warn(w);
  }
  if (remote !== undefined) {
    try {
      git(['push', remote, '--delete', branch], opts.fromDir);
      outcome.branchDeletedRemote = true;
    } catch {
      const w = `Could not delete remote branch '${remote}/${branch}'; continuing.`;
      outcome.warnings.push(w);
      warn(w);
    }
  }
}

// ---- active-run guard ------------------------------------------------------

/** Result of {@link checkActiveRunGuard}. */
export interface ActiveRunGuardResult {
  /** `true` when cleanup may proceed (no live lock on a target). */
  ok: boolean;
  /** The active run id, when refused. */
  runId?: string;
  /** The active holder pid, when refused. */
  pid?: number;
  /** The refusal message, when refused. */
  message?: string;
}

/**
 * Refuse cleanup of any target that is currently active. Reads the central-store
 * `run.lock`; if its `runId` is among `targetRunIds` AND its `pid` is alive,
 * returns `{ ok: false, ... }` naming the run id and pid. A stale lock (dead
 * pid) or a non-matching lock is ignored (`{ ok: true }`).
 *
 * Side-effect-free: the caller maps a non-`ok` result to a non-zero exit and
 * removes nothing.
 */
export function checkActiveRunGuard(
  lockPath: string,
  targetRunIds: readonly string[],
  isAlive: IsAlive = defaultIsAlive,
): ActiveRunGuardResult {
  const holder = readRunLock(lockPath);
  if (holder === undefined) return { ok: true };
  if (!targetRunIds.includes(holder.runId)) return { ok: true };
  if (!isAlive(holder.pid)) return { ok: true }; // stale lock; ignore
  return {
    ok: false,
    runId: holder.runId,
    pid: holder.pid,
    message:
      `Cannot clean up ${holder.runId}; it is currently active (pid ${holder.pid}). ` +
      `Stop the run first.`,
  };
}

/** Render a display-form path for a worktree (used in cleanup reports). */
export function displayWorktree(p: string): string {
  return canonicalizePathForDisplay(p);
}

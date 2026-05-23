

/**
 * Plan and execute teardown of a `/gan` run's on-disk footprint: its run
 * directory, the worktree it ran in, and the branch that worktree held.
 *
 * The module is split into a pure planning phase ({@link planRunCleanup}) and a
 * side-effecting execution phase ({@link executeRunCleanup}). Planning inspects
 * git state and decides *what* should happen ({@link RunCleanupPlan}); execution
 * carries it out and reports *what did* happen ({@link RunCleanupOutcome}). The
 * split lets callers preview a destructive cleanup before committing to it.
 *
 * Two safety invariants run through the whole module:
 * 1. Only artifacts the framework created are ever removed. A run the user set
 *    up themselves (`createdByGan !== true`) is left entirely alone — its
 *    worktree and branch are never touched.
 * 2. An unmerged branch is never silently deleted: the default plan only warns,
 *    and deletion happens solely when the caller passes `--yes`. This prevents
 *    cleanup from destroying commits that exist nowhere else.
 *
 * Removing the run directory is treated as the one hard failure (it THROWS);
 * worktree and branch removal failures are downgraded to warnings so a stuck
 * git operation cannot block reclaiming the run's disk space.
 */
import { rmSync } from 'node:fs';

import { createError } from '../errors.js';
import type { EnumeratedRun } from './run-enumerator.js';
import { readRunLock, defaultIsAlive, type IsAlive } from './run-lock.js';
import { defaultGitExec, resolveDefaultBranch, type GitExec } from './worktree-resolver.js';

/** Injectable directory-removal seam (recursive `rm -rf`-style). Overridden in
 * tests to assert on what would be deleted without touching the real disk. */
export type RmDir = (dir: string) => void;

/** Production {@link RmDir}: recursive, force-removes `dir` and never throws on
 * a missing directory (`force: true`), so a double-cleanup is idempotent. */
export const defaultRmDir: RmDir = (dir) => rmSync(dir, { recursive: true, force: true });

/**
 * What should happen to a run's branch during cleanup. The three arms are
 * mutually exclusive:
 * - `none` — do nothing. `reason` distinguishes a user-owned run from a
 *   gan-owned run that simply has no branch to clean.
 * - `delete-merged` — the branch is fully merged and safe to delete; `remote`
 *   (when present) names the remote whose tracking branch should also be
 *   deleted.
 * - `warn-unmerged` — the branch has commits not reachable from its base or
 *   upstream; deletion would lose work, so it is withheld pending `--yes`.
 */
export type BranchPlan =
  | { kind: 'none'; reason: 'user-owned' | 'no-branch' }
  | { kind: 'delete-merged'; branch: string; remote?: string }
  | { kind: 'warn-unmerged'; branch: string };

/**
 * The cleanup decision for a single run, produced by {@link planRunCleanup} and
 * consumed by {@link executeRunCleanup}. Pure data — computing it performs git
 * reads but no mutations.
 *
 * @property runId the run's identifier (timestamp-suffix form).
 * @property runDir absolute path to the run's directory in the central store;
 *   always removed by execution regardless of ownership.
 * @property createdByGan whether the framework created this run's workspace.
 *   When `false`, worktree/branch are left untouched (only `runDir` is removed).
 * @property worktreePath absolute path of the run's worktree, present only for
 *   gan-created runs that have one.
 * @property branchPlan the per-branch decision; see {@link BranchPlan}.
 */
export interface RunCleanupPlan {

  runId: string;

  runDir: string;

  createdByGan: boolean;

  worktreePath?: string;

  branchPlan: BranchPlan;
}

/**
 * Report of what {@link executeRunCleanup} actually did. Each boolean flips to
 * `true` only when the corresponding action succeeded; warnings collect the
 * human-readable lines for steps that were skipped or failed soft.
 *
 * @property runId the run that was cleaned.
 * @property runDirRemoved whether the run directory was removed (the only step
 *   whose failure throws, so on a returned outcome this is always `true`).
 * @property worktreeRemoved whether the worktree was removed.
 * @property branchDeletedLocal whether the local branch was deleted.
 * @property branchDeletedRemote whether the remote tracking branch was deleted.
 * @property warnings accumulated soft-failure / skip messages, also emitted via
 *   the `warn` sink as they occur.
 */
export interface RunCleanupOutcome {
  runId: string;

  runDirRemoved: boolean;

  worktreeRemoved: boolean;

  branchDeletedLocal: boolean;

  branchDeletedRemote: boolean;

  warnings: string[];
}

/**
 * Inputs shared by planning and execution.
 *
 * @property git git executor seam; defaults to {@link defaultGitExec}.
 * @property fromDir directory git commands run in (`-C`/cwd); must sit inside
 *   the repository whose worktrees/branches are being cleaned.
 * @property remote remote name for tracking-branch deletion; defaults to
 *   `'origin'`.
 * @property defaultBranch optional explicit merge base; when omitted the base
 *   is derived from the run record or, failing that, the repo's default branch.
 */
export interface CleanupOptions {

  git?: GitExec;

  fromDir: string;

  remote?: string;

  defaultBranch?: string;
}

/**
 * Pick the ref to test the run's branch against for "is it merged?".
 *
 * Precedence: the base branch the run recorded at start (authoritative — it is
 * what the run actually diverged from), then a caller-supplied override, then
 * the repository's discovered default branch. Returns `undefined` when none can
 * be determined, in which case merge-detection falls back to upstream only.
 *
 * @param git git executor.
 * @param fromDir directory git runs in.
 * @param run the run whose `baseBranch` is preferred when present.
 * @param defaultBranch caller override, used only if the run recorded no base.
 */
export function resolveMergeBase(
  git: GitExec,
  fromDir: string,
  run: EnumeratedRun,
  defaultBranch?: string,
): string | undefined {
  if (typeof run.baseBranch === 'string' && run.baseBranch.length > 0) return run.baseBranch;
  return defaultBranch ?? resolveDefaultBranch(git, fromDir);
}

/**
 * Decide whether `branch` is fully merged — i.e. safe to delete without losing
 * commits. A branch counts as merged when it is an ancestor of *either* its
 * base ref *or* its upstream tracking branch (whichever exist). Checking both
 * avoids a false "unmerged" when work landed via one path but not the other
 * (e.g. merged into the remote but the local base hasn't been pulled).
 *
 * @param git git executor.
 * @param fromDir directory git runs in.
 * @param branch the branch under test.
 * @param base the base ref to test against; `undefined`/empty contributes no
 *   ref, leaving only the upstream check.
 * @returns `true` if `branch` is an ancestor of any candidate ref. Never throws
 *   — git failures are treated as "not an ancestor of that ref".
 */
export function isBranchMerged(
  git: GitExec,
  fromDir: string,
  branch: string,
  base: string | undefined,
): boolean {
  const refs: string[] = [];
  if (base !== undefined && base.length > 0) refs.push(base);
  const upstream = resolveUpstream(git, fromDir, branch);
  if (upstream !== undefined) refs.push(upstream);
  return isMergedIntoAny(git, fromDir, branch, refs);
}

/**
 * Resolve `branch`'s configured upstream (e.g. `origin/feature/x`), or
 * `undefined` when the branch has no tracking ref. The git command errors when
 * no upstream is set, so the throw is caught and folded into `undefined` rather
 * than propagated — "no upstream" is a normal state, not a fault.
 */
function resolveUpstream(git: GitExec, fromDir: string, branch: string): string | undefined {
  try {
    const out = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], fromDir).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return `true` if `branch` is an ancestor of any ref in `refs`. Uses
 * `git merge-base --is-ancestor`, which exits non-zero (and so throws here)
 * when the branch is *not* an ancestor — that non-zero is the expected "no"
 * answer for this ref, so it is swallowed and the loop tries the next ref.
 */
function isMergedIntoAny(
  git: GitExec,
  fromDir: string,
  branch: string,
  refs: readonly string[],
): boolean {
  for (const ref of refs) {
    try {
      git(['merge-base', '--is-ancestor', branch, ref], fromDir);
      return true;
    } catch {
      // Non-zero => not an ancestor of this ref; try the next.
    }
  }
  return false;
}

/**
 * Compute the cleanup plan for one run without performing any deletion. Pure
 * apart from git *reads* (merge/upstream detection).
 *
 * Decision flow:
 * 1. Not gan-created → `branchPlan: none/user-owned`, no worktree touched.
 * 2. Gan-created but no branch recorded → `none/no-branch`.
 * 3. Gan-created with a branch → test merged-ness; `warn-unmerged` if not
 *    merged, else `delete-merged` (carrying `remote` only when an upstream
 *    exists, so a purely-local branch is not pushed-deleted).
 *
 * @param run the enumerated run to plan for; its `workspace`/`runBranch`/
 *   `baseBranch` fields drive the decision.
 * @param opts see {@link CleanupOptions}.
 * @returns the {@link RunCleanupPlan}; never throws.
 */
export function planRunCleanup(run: EnumeratedRun, opts: CleanupOptions): RunCleanupPlan {
  const git = opts.git ?? defaultGitExec;
  const remote = opts.remote ?? 'origin';
  const createdByGan = run.workspace?.createdByGan === true;

  if (!createdByGan) {
    // User-owned run: only the run directory is ours to remove; the worktree
    // and branch belong to the user and are left entirely untouched.
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

  const base = resolveMergeBase(git, opts.fromDir, run, opts.defaultBranch);
  const upstream = resolveUpstream(git, opts.fromDir, branch);
  const refs: string[] = [];
  if (base !== undefined && base.length > 0) refs.push(base);
  if (upstream !== undefined) refs.push(upstream);
  const merged = isMergedIntoAny(git, opts.fromDir, branch, refs);

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
  if (upstream !== undefined) branchPlan.remote = remote;
  return {
    runId: run.runId,
    runDir: run.runDir,
    createdByGan: true,
    worktreePath,
    branchPlan,
  };
}

/**
 * Execution-time inputs, extending {@link CleanupOptions}.
 *
 * @property yes when `true`, authorises deleting an unmerged branch (the
 *   `warn-unmerged` plan) — the explicit opt-in that overrides the safety
 *   default of refusing to drop unmerged work.
 * @property rmDir directory-removal seam; defaults to {@link defaultRmDir}.
 * @property warn sink for warnings; defaults to writing to `stderr`.
 */
export interface ExecuteCleanupOptions extends CleanupOptions {

  yes?: boolean;

  rmDir?: RmDir;

  warn?: (line: string) => void;
}

/**
 * Carry out a {@link RunCleanupPlan}, removing the worktree, handling the
 * branch, and removing the run directory, in that order.
 *
 * Ordering is deliberate: the worktree is removed before the run directory so
 * the worktree's git metadata is gone first; branch handling sits between them.
 *
 * Side effects: removes a git worktree, deletes local/remote branches, and
 * recursively removes the run directory — all on disk and in git.
 *
 * Failure modes: worktree removal and branch deletion failures are SOFT — they
 * are recorded in `outcome.warnings`, emitted via `warn`, and execution
 * continues. Only run-directory removal is HARD: a failure THROWS
 * `ConfigServerError('MalformedInput')`, because leaving the run directory
 * behind would defeat the entire cleanup.
 *
 * @param plan the precomputed plan (see {@link planRunCleanup}).
 * @param opts see {@link ExecuteCleanupOptions}.
 * @returns a {@link RunCleanupOutcome} describing what succeeded.
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

  if (plan.createdByGan && plan.worktreePath !== undefined) {
    try {
      // `--force` so a dirty worktree is still removed: cleanup is invoked on a
      // run we are tearing down, where uncommitted changes in its scratch
      // worktree are expected and discardable.
      git(['worktree', 'remove', '--force', plan.worktreePath], opts.fromDir);
      outcome.worktreeRemoved = true;
    } catch {
      // Soft failure: a stuck/locked worktree must not block reclaiming the
      // run directory, so we warn and press on.
      const w = `Run ${plan.runId}: could not remove worktree ${plan.worktreePath}; continuing.`;
      outcome.warnings.push(w);
      warn(w);
    }
  }

  handleBranch(plan, opts, git, warn, outcome);

  try {
    rmDir(plan.runDir);
    outcome.runDirRemoved = true;
  } catch (e) {
    // The one hard failure: if the run directory survives, the run is not
    // actually cleaned up, so this propagates instead of degrading to a warning.
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

/**
 * Apply the branch portion of a plan. A `none` plan is a no-op; a
 * `delete-merged` plan deletes local (and, if a remote was recorded, remote);
 * a `warn-unmerged` plan only warns — unless `opts.yes` is set, the gate that
 * authorises destroying unmerged commits. All git failures here are soft.
 */
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

  const line =
    `Run ${plan.runId}: branch '${bp.branch}' is not merged into its base/upstream; ` +
    `its commits would be lost if deleted.`;
  outcome.warnings.push(line);
  warn(line);
  if (opts.yes === true) {
    // `remote` is passed as undefined here on purpose: a forced delete of an
    // unmerged branch only drops the local ref, never the pushed copy — the
    // remote remains as a recovery point for the un-merged commits.
    warn(`Run ${plan.runId}: deleting unmerged branch '${bp.branch}' (--yes given).`);
    deleteBranchLocalAndRemote(bp.branch, undefined, opts, git, warn, outcome);
  }
  // Without --yes: leave the branch in place (no delete argv issued).
}

/**
 * Delete `branch` locally and, when `remote` is given, on that remote too.
 * Local deletion uses `-D` (force) because the merged-ness check already
 * happened during planning; relying on git's own `-d` merge check here would
 * double-check against the wrong base. Both deletions are soft — a failure is
 * warned and recorded, never thrown — so a missing or protected branch does not
 * abort the surrounding cleanup.
 */
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

/**
 * Outcome of the pre-cleanup safety check.
 *
 * @property ok `true` when cleanup may proceed; `false` when a target run is
 *   live and must not be torn down.
 * @property runId the live run's id (only on `ok: false`).
 * @property pid the live run's process id (only on `ok: false`).
 * @property message human-readable refusal explaining why and what to do (only
 *   on `ok: false`).
 */
export interface ActiveRunGuardResult {

  ok: boolean;

  runId?: string;

  pid?: number;

  message?: string;
}

/**
 * Refuse to clean up a run that is currently executing. Reads the repo's run
 * lock and blocks (`ok: false`) only when all three hold: a lock is present,
 * its holder is one of `targetRunIds`, and that holder's process is still
 * alive. A stale lock (holder process gone) does not block — `ok: true`.
 *
 * @param lockPath path to the repository's `run.lock`.
 * @param targetRunIds the run ids the caller intends to clean; the guard only
 *   fires when the live lock holder is among them.
 * @param isAlive liveness probe for the holder pid; defaults to
 *   {@link defaultIsAlive}. Injected in tests to simulate a live/dead holder.
 * @returns an {@link ActiveRunGuardResult}; never throws.
 */
export function checkActiveRunGuard(
  lockPath: string,
  targetRunIds: readonly string[],
  isAlive: IsAlive = defaultIsAlive,
): ActiveRunGuardResult {
  const holder = readRunLock(lockPath);
  if (holder === undefined) return { ok: true };
  if (!targetRunIds.includes(holder.runId)) return { ok: true };
  if (!isAlive(holder.pid)) return { ok: true };
  return {
    ok: false,
    runId: holder.runId,
    pid: holder.pid,
    message:
      `Cannot clean up ${holder.runId}; it is currently active (pid ${holder.pid}). ` +
      `Stop the run first.`,
  };
}



import { rmSync } from 'node:fs';

import { createError } from '../errors.js';
import type { EnumeratedRun } from './run-enumerator.js';
import { readRunLock, defaultIsAlive, type IsAlive } from './run-lock.js';
import { defaultGitExec, resolveDefaultBranch, type GitExec } from './worktree-resolver.js';

export type RmDir = (dir: string) => void;

export const defaultRmDir: RmDir = (dir) => rmSync(dir, { recursive: true, force: true });

export type BranchPlan =
  | { kind: 'none'; reason: 'user-owned' | 'no-branch' }
  | { kind: 'delete-merged'; branch: string; remote?: string }
  | { kind: 'warn-unmerged'; branch: string };

export interface RunCleanupPlan {

  runId: string;

  runDir: string;

  createdByGan: boolean;

  worktreePath?: string;

  branchPlan: BranchPlan;
}

export interface RunCleanupOutcome {
  runId: string;

  runDirRemoved: boolean;

  worktreeRemoved: boolean;

  branchDeletedLocal: boolean;

  branchDeletedRemote: boolean;

  warnings: string[];
}

export interface CleanupOptions {

  git?: GitExec;

  fromDir: string;

  remote?: string;

  defaultBranch?: string;
}

export function resolveMergeBase(
  git: GitExec,
  fromDir: string,
  run: EnumeratedRun,
  defaultBranch?: string,
): string | undefined {
  if (typeof run.baseBranch === 'string' && run.baseBranch.length > 0) return run.baseBranch;
  return defaultBranch ?? resolveDefaultBranch(git, fromDir);
}

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

function resolveUpstream(git: GitExec, fromDir: string, branch: string): string | undefined {
  try {
    const out = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], fromDir).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

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

export function planRunCleanup(run: EnumeratedRun, opts: CleanupOptions): RunCleanupPlan {
  const git = opts.git ?? defaultGitExec;
  const remote = opts.remote ?? 'origin';
  const createdByGan = run.workspace?.createdByGan === true;

  if (!createdByGan) {

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

export interface ExecuteCleanupOptions extends CleanupOptions {

  yes?: boolean;

  rmDir?: RmDir;

  warn?: (line: string) => void;
}

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
      git(['worktree', 'remove', '--force', plan.worktreePath], opts.fromDir);
      outcome.worktreeRemoved = true;
    } catch {
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

  const line =
    `Run ${plan.runId}: branch '${bp.branch}' is not merged into its base/upstream; ` +
    `its commits would be lost if deleted.`;
  outcome.warnings.push(line);
  warn(line);
  if (opts.yes === true) {

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

export interface ActiveRunGuardResult {

  ok: boolean;

  runId?: string;

  pid?: number;

  message?: string;
}

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

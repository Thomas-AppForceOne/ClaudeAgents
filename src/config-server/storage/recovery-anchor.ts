

import { existsSync } from 'node:fs';

import { canonicalizePath, canonicalizePathForDisplay } from '../determinism/index.js';

export interface WorkspaceAnchor {

  worktreePath: string;

  branch: string;
}

export interface RecoveryAnchorResult {

  ok: boolean;

  refusal?: 'wrong-worktree' | 'missing-worktree';

  message?: string;
}

export interface CheckRecoveryAnchorOptions {

  runId: string;

  workspace: WorkspaceAnchor;

  fromDir?: string;

  worktreeExists?: (p: string) => boolean;
}

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

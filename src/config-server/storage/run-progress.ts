

import { atomicWriteFile } from './atomic-write.js';
import { canonicalizePathForDisplay, stableStringify } from '../determinism/index.js';
import { readJsonObjectFile, stripForbiddenKeys } from './json-read.js';
import type { ResolvedWorkspace } from './worktree-resolver.js';

export interface WorkspaceRecord {

  worktreePath: string;

  branch: string;

  createdByGan: boolean;
}

export function buildWorkspaceRecord(resolved: ResolvedWorkspace): WorkspaceRecord {
  return {
    worktreePath: canonicalizePathForDisplay(resolved.worktreePath),
    branch: resolved.branch,
    createdByGan: resolved.createdByGan,
  };
}

export function recordWorkspace(
  progressPath: string,
  resolved: ResolvedWorkspace,
): WorkspaceRecord {
  const record = buildWorkspaceRecord(resolved);
  const base = readProgressObject(progressPath);
  const next: Record<string, unknown> = { ...base, workspace: record };
  atomicWriteFile(progressPath, stableStringify(next));
  return record;
}

function readProgressObject(progressPath: string): Record<string, unknown> {
  const obj = readJsonObjectFile(progressPath);
  return obj === undefined ? {} : stripForbiddenKeys(obj);
}

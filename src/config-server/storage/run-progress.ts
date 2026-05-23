

/**
 * Persist a run's resolved workspace into its `progress.json`.
 *
 * The workspace record is the anchor later used for recovery (see
 * recovery-anchor) and the basis for cleanup decisions, so it is written
 * durably. The write is a *merge*: existing progress fields are preserved and
 * only the `workspace` key is set/replaced, so recording a workspace never
 * clobbers other progress the run has accumulated. Paths are stored in
 * canonical *display* form for stable, human-readable comparison across
 * worktrees.
 */
import { atomicWriteFile } from './atomic-write.js';
import { canonicalizePathForDisplay, stableStringify } from '../determinism/index.js';
import { readJsonObjectFile, stripForbiddenKeys } from './json-read.js';
import type { ResolvedWorkspace } from './worktree-resolver.js';

/**
 * The workspace facts persisted into progress.
 *
 * @property worktreePath the run's worktree, canonicalised for display.
 * @property branch the branch checked out there.
 * @property createdByGan whether the framework created the workspace (drives
 *   whether cleanup may later remove it).
 */
export interface WorkspaceRecord {

  worktreePath: string;

  branch: string;

  createdByGan: boolean;
}

/**
 * Project a {@link ResolvedWorkspace} into the persisted {@link WorkspaceRecord},
 * canonicalising the worktree path for display. Pure — no I/O.
 *
 * @param resolved the workspace resolution to record.
 * @returns the record shape written into progress.
 */
export function buildWorkspaceRecord(resolved: ResolvedWorkspace): WorkspaceRecord {
  return {
    worktreePath: canonicalizePathForDisplay(resolved.worktreePath),
    branch: resolved.branch,
    createdByGan: resolved.createdByGan,
  };
}

/**
 * Write the run's workspace into `progress.json`, merging into any existing
 * progress.
 *
 * @param progressPath path to the run's `progress.json`.
 * @param resolved the resolved workspace to record.
 * @returns the {@link WorkspaceRecord} that was written.
 *
 * Side effect: atomically rewrites `progressPath` with the merged document
 * (existing keys preserved, `workspace` set). Serialised deterministically via
 * {@link stableStringify} so equal state yields byte-identical output.
 * @throws `ConfigServerError('MalformedInput')` from {@link atomicWriteFile} on
 *   an I/O failure.
 */
export function recordWorkspace(
  progressPath: string,
  resolved: ResolvedWorkspace,
): WorkspaceRecord {
  const record = buildWorkspaceRecord(resolved);
  const base = readProgressObject(progressPath);
  // Spread existing progress first, then set workspace: this preserves any
  // other fields the run already wrote and replaces only the workspace key.
  const next: Record<string, unknown> = { ...base, workspace: record };
  atomicWriteFile(progressPath, stableStringify(next));
  return record;
}

/**
 * Read existing progress as a prototype-sanitised object, or `{}` when absent /
 * unreadable. Returning `{}` (rather than failing) lets the first
 * workspace-record write seed a fresh progress file. Sanitised because the
 * result is spread into the object that gets written back.
 */
function readProgressObject(progressPath: string): Record<string, unknown> {
  const obj = readJsonObjectFile(progressPath);
  return obj === undefined ? {} : stripForbiddenKeys(obj);
}

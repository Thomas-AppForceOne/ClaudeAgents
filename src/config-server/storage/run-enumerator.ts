

/**
 * Enumerate the `/gan` runs recorded in a repository's run store.
 *
 * It scans the runs directory for run-id-shaped subdirectories, reads each
 * run's optional `progress.json`, and projects a normalised {@link EnumeratedRun}
 * record. Reads are deliberately tolerant: a run with no/unreadable/corrupt
 * progress is still enumerated (with `hasProgress: false`), because the
 * directory's existence is enough to list it for cleanup or recovery. Progress
 * JSON is untrusted on-disk data, so it is prototype-sanitised
 * ({@link stripForbiddenKeys}) and each field is copied across only when it has
 * the expected type — a malformed field is ignored, never trusted.
 *
 * Runs are returned newest-first by directory mtime.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJsonObjectFile, stripForbiddenKeys } from './json-read.js';
import { RUN_ID_PATTERN } from './run-store.js';

/**
 * Workspace facts projected from a run's progress (all optional — progress may
 * predate these fields or omit them).
 *
 * @property worktreePath the worktree the run used.
 * @property branch the branch checked out in that worktree.
 * @property createdByGan whether the framework created the workspace (governs
 *   whether cleanup may remove it).
 */
export interface EnumeratedWorkspace {

  worktreePath?: string;

  branch?: string;

  createdByGan?: boolean;
}

/**
 * A normalised view of one run on disk.
 *
 * @property runId the run id (directory name, run-id-pattern shaped).
 * @property runDir absolute path to the run directory.
 * @property progressPath absolute path to the run's `progress.json` (whether or
 *   not it exists).
 * @property hasProgress whether a readable progress object was found.
 * @property mtimeMs the run directory's modification time, used for sort order.
 * @property projectRoot the project the run targeted (from progress, if valid).
 * @property workspace the run's workspace facts (from progress, if valid).
 * @property terminal whether the run reached a terminal state.
 * @property terminalReason why it terminated, if recorded.
 * @property status the run's recorded status string.
 * @property runBranch the run's branch, if recorded directly.
 * @property baseBranch the branch the run diverged from (used by cleanup as the
 *   merge base).
 */
export interface EnumeratedRun {

  runId: string;

  runDir: string;

  progressPath: string;

  hasProgress: boolean;

  mtimeMs: number;

  projectRoot?: string;

  workspace?: EnumeratedWorkspace;

  terminal?: boolean;

  terminalReason?: string;

  status?: string;

  runBranch?: string;

  baseBranch?: string;
}

/**
 * List all runs under `runsRoot`, newest first.
 *
 * @param runsRoot the repository's `runs` directory.
 * @returns the enumerated runs sorted by descending directory mtime; an empty
 *   array if `runsRoot` is absent or unreadable. Never throws — unreadable or
 *   non-directory entries are skipped, and a directory name that does not match
 *   {@link RUN_ID_PATTERN} is ignored (so stray files cannot masquerade as runs).
 */
export function enumerateRuns(runsRoot: string): EnumeratedRun[] {
  if (!existsSync(runsRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return [];
  }

  const runs: EnumeratedRun[] = [];
  for (const name of entries) {
    // Only run-id-shaped names are runs; this filters out any incidental files
    // (e.g. run.lock) sharing the directory.
    if (!RUN_ID_PATTERN.test(name)) continue;
    const runDir = path.join(runsRoot, name);
    let dirStat;
    try {
      dirStat = statSync(runDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const progressPath = path.join(runDir, 'progress.json');
    const record: EnumeratedRun = {
      runId: name,
      runDir,
      progressPath,
      hasProgress: false,
      mtimeMs: dirStat.mtimeMs,
    };
    const progress = readProgress(progressPath);
    if (progress !== undefined) {
      record.hasProgress = true;
      applyProgress(record, progress);
    }
    runs.push(record);
  }

  // Newest first: most recovery/cleanup callers care about recent runs.
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs;
}

/**
 * Read a run's `progress.json` as a prototype-sanitised object, or `undefined`
 * when it is absent/unreadable/non-object. The sanitise step matters because
 * progress is untrusted on-disk data spread into other objects downstream.
 */
function readProgress(progressPath: string): Record<string, unknown> | undefined {
  const obj = readJsonObjectFile(progressPath);
  return obj === undefined ? undefined : stripForbiddenKeys(obj);
}

/**
 * Copy known fields from a raw progress object onto `record`, in place.
 *
 * Each field is type-checked before being copied, so a field present with the
 * wrong type is silently skipped rather than corrupting the record — defensive
 * because progress JSON is user/tool-written and may be malformed or stale.
 * The nested `workspace` object is validated and rebuilt field-by-field for the
 * same reason.
 */
function applyProgress(record: EnumeratedRun, progress: Record<string, unknown>): void {
  if (typeof progress.projectRoot === 'string') record.projectRoot = progress.projectRoot;
  if (typeof progress.terminal === 'boolean') record.terminal = progress.terminal;
  if (typeof progress.terminalReason === 'string') record.terminalReason = progress.terminalReason;
  if (typeof progress.status === 'string') record.status = progress.status;
  if (typeof progress.runBranch === 'string') record.runBranch = progress.runBranch;
  if (typeof progress.baseBranch === 'string') record.baseBranch = progress.baseBranch;

  const ws = progress.workspace;
  if (ws !== null && typeof ws === 'object' && !Array.isArray(ws)) {
    const w = ws as Record<string, unknown>;
    const workspace: EnumeratedWorkspace = {};
    if (typeof w.worktreePath === 'string') workspace.worktreePath = w.worktreePath;
    if (typeof w.branch === 'string') workspace.branch = w.branch;
    if (typeof w.createdByGan === 'boolean') workspace.createdByGan = w.createdByGan;
    record.workspace = workspace;
  }
}

/**
 * Find a single run by id.
 *
 * @param runsRoot the repository's `runs` directory.
 * @param runId the run id to locate.
 * @returns the matching {@link EnumeratedRun}, or `undefined` if no such run
 *   exists. Enumerates all runs and filters, so the same tolerant reading rules
 *   apply.
 */
export function findRun(runsRoot: string, runId: string): EnumeratedRun | undefined {
  return enumerateRuns(runsRoot).find((r) => r.runId === runId);
}

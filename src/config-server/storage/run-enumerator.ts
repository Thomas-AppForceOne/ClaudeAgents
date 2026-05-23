

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJsonObjectFile, stripForbiddenKeys } from './json-read.js';
import { RUN_ID_PATTERN } from './run-store.js';

export interface EnumeratedWorkspace {

  worktreePath?: string;

  branch?: string;

  createdByGan?: boolean;
}

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

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs;
}

function readProgress(progressPath: string): Record<string, unknown> | undefined {
  const obj = readJsonObjectFile(progressPath);
  return obj === undefined ? undefined : stripForbiddenKeys(obj);
}

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

export function findRun(runsRoot: string, runId: string): EnumeratedRun | undefined {
  return enumerateRuns(runsRoot).find((r) => r.runId === runId);
}

/**
 * F7 slice 4 — repo-wide run enumeration, re-anchored to the central store
 * (over O2 §4 / §4-list-recoverable / §5.5-cleanup).
 *
 * O2 enumerated runs under `<projectRoot>/.gan-state/runs/*`. Under F7 that
 * directory holds only a gan-created worktree (cases 1b/1c) and differs per
 * worktree, so enumerating it would make a run started in worktree A invisible
 * from worktree B. F7 enumerates the central, repo-keyed store instead —
 * `<store-root>/<repo-key>/runs/` (slice-1 {@link resolveRunsRoot}) — so every
 * run of the repo is visible from ANY worktree (all worktrees key to the same
 * `<repo-key>`). `--list-recoverable` and `--cleanup` both build on this.
 *
 * `progress.json.projectRoot` (the canonical main-worktree root) is what O2's
 * cross-project refusal compares against; this enumerator surfaces it on each
 * record so the orchestrator can apply that check, but it does NOT itself
 * refuse — enumeration is discovery, not resume.
 *
 * Read-only invariant: this module only reads `<store-root>/<repo-key>/runs/`
 * and the `progress.json` inside each run directory. It never mutates run state,
 * never writes anywhere, and never reads or writes the module-state store,
 * `.claude/gan/`, or `.gan-cache/`. It spawns no subprocess.
 *
 * Untrusted-input safety: `progress.json` is attacker-influenceable. Parsing
 * reads only pre-defined SCALAR fields by name (runId, workspace.worktreePath,
 * workspace.branch, workspace.createdByGan, projectRoot, terminal,
 * terminalReason, status, runBranch, baseBranch) and never merges attacker keys
 * into an object or its prototype — `__proto__` / `constructor` / `prototype`
 * keys are skipped on read (mirroring the slice-2 run-progress reader).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The workspace block surfaced from a run's `progress.json`. */
export interface EnumeratedWorkspace {
  /** Canonical absolute worktree path (the recovery anchor). */
  worktreePath?: string;
  /** The branch the run executes on. */
  branch?: string;
  /** True only for gan-created worktrees (cases 1b/1c). */
  createdByGan?: boolean;
}

/** One enumerated run. */
export interface EnumeratedRun {
  /** The run id (directory name under `runs/`). */
  runId: string;
  /** Absolute path of the run directory under the central store. */
  runDir: string;
  /** Absolute path of the run's `progress.json` (whether or not it exists). */
  progressPath: string;
  /** `true` when `progress.json` was present and parseable. */
  hasProgress: boolean;
  /** Directory mtime (epoch ms) — most-recent-first sort key. */
  mtimeMs: number;
  /** The canonical main-worktree root recorded at run start (cross-project key). */
  projectRoot?: string;
  /** Resolved workspace block, when recorded. */
  workspace?: EnumeratedWorkspace;
  /** `progress.json.terminal` (missing -> treated as non-terminal/recoverable). */
  terminal?: boolean;
  /** `progress.json.terminalReason`, when set. */
  terminalReason?: string;
  /** `progress.json.status`, when set. */
  status?: string;
  /** `progress.json.runBranch`, when set. */
  runBranch?: string;
  /** `progress.json.baseBranch`, when set. */
  baseBranch?: string;
}

/**
 * Enumerate every run directory under `runsRoot`
 * (`<store-root>/<repo-key>/runs/`), reading each run's `progress.json`.
 *
 * Returns records sorted by directory mtime DESCENDING (most-recently-active
 * first), matching O2's `--list-recoverable` / `--cleanup` ordering. A run
 * directory whose name does not match the run-id grammar is skipped, so a
 * stray file or unrelated directory under `runs/` cannot masquerade as a run.
 *
 * Read-only: opens nothing outside `runsRoot`. When `runsRoot` does not exist,
 * returns an empty array (no runs yet for this repo).
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
    if (!RUN_ID_DIR_PATTERN.test(name)) continue; // skip non-run entries
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

/** Run-id directory grammar `<YYYYMMDDTHHMMSS>-<4 hex>` (mirrors slice-1). */
const RUN_ID_DIR_PATTERN = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/;

/**
 * Parse `progress.json` into a plain object, skipping prototype-polluting keys.
 * Returns `undefined` when the file is absent, unreadable, or not a JSON object.
 */
function readProgress(progressPath: string): Record<string, unknown> | undefined {
  if (!existsSync(progressPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v;
  }
  return out;
}

/** Copy the pre-defined scalar fields off a parsed progress object. */
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

/** Look up a single enumerated run by id, or `undefined` if not present. */
export function findRun(runsRoot: string, runId: string): EnumeratedRun | undefined {
  return enumerateRuns(runsRoot).find((r) => r.runId === runId);
}

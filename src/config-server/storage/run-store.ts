

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { mainWorktreeRoot as deriveMainWorktreeRoot, type GitExec } from './git-exec.js';
import { resolveStoreRootByPrecedence, type StoreEnv } from './store-common.js';

export type { StoreEnv } from './store-common.js';

export const DEFAULT_STORE_DIRNAME = '.gan-runs-data';

export const STORE_MARKER_RELPATH = path.join('.claude', 'gan', 'runs-data-dir');

export const STORE_ROOT_ENV = 'GAN_RUNS_DATA';

export const REPO_KEY_HASH_LENGTH = 12;

export const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/;

export const REPO_KEY_HASH_TAIL = /-[0-9a-f]{12}$/;

export function resolveStoreRoot(deps?: StoreEnv): string {
  return resolveStoreRootByPrecedence(
    {
      envVar: STORE_ROOT_ENV,
      markerRelpath: STORE_MARKER_RELPATH,
      defaultDirname: DEFAULT_STORE_DIRNAME,
    },
    deps,
  );
}

export function resolveMainWorktreeRoot(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {

  const git: GitExec = (args, cwd) =>
    exec('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return deriveMainWorktreeRoot(git, fromDir);
}

export function computeRepoKey(mainWorktreeRoot: string): string {
  const canonical = canonicalizePath(mainWorktreeRoot);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  const basename = path.basename(canonical);
  return `${basename}-${hash}`;
}

export function resolveRepoKey(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {
  return computeRepoKey(resolveMainWorktreeRoot(fromDir, exec));
}

export function resolveRepoStoreDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

export function resolveRunLockPath(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'run.lock');
}

export function resolveRunsRoot(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'runs');
}

export function resolveRunDir(storeRoot: string, repoKey: string, runId: string): string {
  return path.join(resolveRunsRoot(storeRoot, repoKey), runId);
}

export interface ResolvedRunStore {

  storeRoot: string;

  repoKey: string;

  mainWorktreeRoot: string;

  repoStoreDir: string;

  runLockPath: string;

  runsRoot: string;

  runDir: string;
}

export function resolveRunStore(opts: {
  runId: string;

  fromDir?: string;
  deps?: StoreEnv;
  exec?: typeof execFileSync;
}): ResolvedRunStore {
  const storeRoot = resolveStoreRoot(opts.deps);
  const mainWorktreeRoot = resolveMainWorktreeRoot(opts.fromDir, opts.exec);
  const repoKey = computeRepoKey(mainWorktreeRoot);
  return {
    storeRoot,
    repoKey,
    mainWorktreeRoot,
    repoStoreDir: resolveRepoStoreDir(storeRoot, repoKey),
    runLockPath: resolveRunLockPath(storeRoot, repoKey),
    runsRoot: resolveRunsRoot(storeRoot, repoKey),
    runDir: resolveRunDir(storeRoot, repoKey, opts.runId),
  };
}

export function generateRunId(now: Date = new Date()): string {
  const ts =
    String(now.getUTCFullYear()).padStart(4, '0') +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    'T' +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0');
  const suffix = randomBytes(2).toString('hex');
  return `${ts}-${suffix}`;
}

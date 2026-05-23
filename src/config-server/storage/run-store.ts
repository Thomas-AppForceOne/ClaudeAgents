

/**
 * Path resolution and identifiers for the run store — the central,
 * per-repository directory tree where `/gan` runs live (run dirs, the run lock,
 * progress).
 *
 * Like the module-state store, runs are keyed by *repository* (via
 * {@link computeRepoKey} over the main worktree root) so all of a repo's
 * worktrees share one store; the store root is resolved by the standard
 * precedence (env → marker → home default), specialised here with the
 * `GAN_RUNS_DATA` env var and `.gan-runs-data` default. This module also owns
 * the run-id format and the regexes used to recognise run ids and repo-key
 * hash tails elsewhere. Everything here is pure path/string computation plus
 * (for the worktree root) a git read; no run files are read or written.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { mainWorktreeRoot as deriveMainWorktreeRoot, type GitExec } from './git-exec.js';
import { resolveStoreRootByPrecedence, type StoreEnv } from './store-common.js';

export type { StoreEnv } from './store-common.js';

/** Default run-store directory name under the user's home, when neither the env
 * var nor a marker file overrides the location. */
export const DEFAULT_STORE_DIRNAME = '.gan-runs-data';

/** Home-relative path of the marker file that redirects the run-store root to
 * the path it contains. */
export const STORE_MARKER_RELPATH = path.join('.claude', 'gan', 'runs-data-dir');

/** Environment variable that takes top precedence for the run-store root. */
export const STORE_ROOT_ENV = 'GAN_RUNS_DATA';

/** Number of hex chars of the path hash kept in a repo key. Twelve is enough to
 * make collisions between distinct repo paths negligible while keeping the key
 * short. */
export const REPO_KEY_HASH_LENGTH = 12;

/** Shape of a run id: `YYYYMMDDThhmmss-<4 hex>` (UTC timestamp + random
 * suffix). Used to recognise run directories among other store entries. */
export const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/;

/** Matches the trailing `-<12 hex>` hash a repo key ends with; used elsewhere
 * to strip/recognise the hash portion of a repo key. */
export const REPO_KEY_HASH_TAIL = /-[0-9a-f]{12}$/;

/**
 * Resolve the run-store root by precedence: `GAN_RUNS_DATA` env var → marker
 * file → `~/.gan-runs-data`.
 *
 * @param deps optional environment seams (`homedir`/`env`) for tests.
 * @returns the absolute store root directory.
 */
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

/**
 * Resolve the repository's main worktree root from `fromDir`.
 *
 * @param fromDir a directory inside the repo; defaults to `process.cwd()`.
 * @param exec the `execFileSync` to run git through; defaults to the real one,
 *   overridable in tests.
 * @returns the absolute main worktree root.
 * @throws when `fromDir` is not inside a git repository (propagated from
 *   {@link deriveMainWorktreeRoot}).
 */
export function resolveMainWorktreeRoot(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {
  // Adapt the injectable execFileSync into the GitExec shape the shared
  // worktree-root helper expects (argv form, stdout-only capture).
  const git: GitExec = (args, cwd) =>
    exec('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return deriveMainWorktreeRoot(git, fromDir);
}

/**
 * Derive the stable per-repository key from a main worktree root.
 *
 * The key is `<basename>-<hash>` where the hash is the first
 * {@link REPO_KEY_HASH_LENGTH} hex chars of `sha256(canonicalPath)`. The path is
 * canonicalised first so the same repo always hashes identically regardless of
 * symlinks/case; the basename prefix keeps the on-disk store directory
 * human-recognisable while the hash guarantees uniqueness between repos that
 * share a basename.
 *
 * @param mainWorktreeRoot the repo's main worktree root.
 * @returns the repo key. Pure.
 */
export function computeRepoKey(mainWorktreeRoot: string): string {
  const canonical = canonicalizePath(mainWorktreeRoot);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  const basename = path.basename(canonical);
  return `${basename}-${hash}`;
}

/**
 * Convenience: resolve the repo key directly from `fromDir` (worktree root →
 * key). See {@link resolveMainWorktreeRoot} and {@link computeRepoKey}.
 */
export function resolveRepoKey(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {
  return computeRepoKey(resolveMainWorktreeRoot(fromDir, exec));
}

/** The per-repository store directory: `<storeRoot>/<repoKey>`. */
export function resolveRepoStoreDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

/** Path of the repo's single run lock: `<storeRoot>/<repoKey>/run.lock`. */
export function resolveRunLockPath(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'run.lock');
}

/** The directory holding all run dirs for a repo:
 * `<storeRoot>/<repoKey>/runs`. */
export function resolveRunsRoot(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'runs');
}

/** A single run's directory: `<storeRoot>/<repoKey>/runs/<runId>`. */
export function resolveRunDir(storeRoot: string, repoKey: string, runId: string): string {
  return path.join(resolveRunsRoot(storeRoot, repoKey), runId);
}

/**
 * Every resolved run-store location for one run.
 *
 * @property storeRoot the resolved store root.
 * @property repoKey the per-repository key.
 * @property mainWorktreeRoot the worktree root the key derives from.
 * @property repoStoreDir the repo's store directory.
 * @property runLockPath the repo's run lock path.
 * @property runsRoot the repo's runs directory.
 * @property runDir this run's directory.
 */
export interface ResolvedRunStore {

  storeRoot: string;

  repoKey: string;

  mainWorktreeRoot: string;

  repoStoreDir: string;

  runLockPath: string;

  runsRoot: string;

  runDir: string;
}

/**
 * Resolve all run-store locations for a given run in one call.
 *
 * @param opts.runId the run whose `runDir` to compute.
 * @param opts.fromDir directory inside the repo; defaults to `process.cwd()`.
 * @param opts.deps environment seams for the store root.
 * @param opts.exec git executor override for the worktree root.
 * @returns a {@link ResolvedRunStore}. Pure path computation plus one git read.
 * @throws when `fromDir` is not inside a git repository.
 */
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

/**
 * Generate a fresh run id of the form `YYYYMMDDThhmmss-<4 hex>`.
 *
 * The timestamp is in UTC (so ids sort chronologically regardless of the
 * machine's timezone) and a 2-byte random suffix disambiguates ids generated
 * within the same second. Conforms to {@link RUN_ID_PATTERN}.
 *
 * @param now clock seam; defaults to the current time. Injected in tests for a
 *   deterministic timestamp.
 * @returns the run id string.
 */
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

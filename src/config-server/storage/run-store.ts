/**
 * F7 slice 1 — central run-data store resolution and repo keying.
 *
 * Run *data* (per-run directories holding `progress.json`, sprint artifacts,
 * `trace/`, `telemetry/`) moves out of the project tree's gitignored
 * `.gan-state/runs/` into a central, repo-keyed store outside any worktree.
 * Relocating it there is what makes a run's data survive `git worktree remove`
 * of the worktree it was started from, and what lets every linked worktree of
 * one repo discover the same runs (they share one `git-common-dir`, so they
 * key to the same store sub-directory).
 *
 * Layout (per the F7 spec §1):
 *
 *   <store-root>/
 *     <repo-key>/                       one directory per repo
 *       run.lock                        repo-level serialization lock (O2 owns)
 *       runs/
 *         <run-id>/                     <YYYYMMDDTHHMMSS>-<4 hex>, O2 owns layout
 *
 * This module owns only the *location* resolution — store-root precedence,
 * repo-key derivation, and the run-directory path. The per-run internal layout
 * and the worktree-aware execution model (cases 1a/1b/1c), confinement-hook
 * path export, recovery/lock re-anchoring, and install-time configuration are
 * out of scope for this slice (later F7 slices / O2 own them).
 *
 * Determinism: the main-worktree path is canonicalised through the centralised
 * determinism module's case-folding {@link canonicalizePath} before hashing, so
 * two linked worktrees (and two spellings of one path differing only by case or
 * a trailing slash) key to the SAME store directory on case-insensitive
 * filesystems. This module never re-implements realpath / lowercasing /
 * trailing-slash stripping — it imports the single pinned implementation.
 *
 * Subprocess safety: the one git invocation (`git rev-parse --git-common-dir`)
 * goes through `execFileSync` with an argv array and a `cwd`; no path or env
 * value is ever interpolated into a shell command line.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { mainWorktreeRoot as deriveMainWorktreeRoot, type GitExec } from './git-exec.js';

/** Default store-root directory name under the user's home directory. */
export const DEFAULT_STORE_DIRNAME = '.gan-runs-data';

/**
 * Install-time marker file (relative to the user's home directory) recording
 * the configured store root. `install.sh` writes it (a later F7 slice); the
 * orchestrator reads it here. `GAN_RUNS_DATA` overrides it per-run.
 */
export const STORE_MARKER_RELPATH = path.join('.claude', 'gan', 'runs-data-dir');

/** Environment variable that overrides the store root for a single run. */
export const STORE_ROOT_ENV = 'GAN_RUNS_DATA';

/** Length of the hex hash segment appended to the repo-key basename. */
export const REPO_KEY_HASH_LENGTH = 12;

/** Validates a generated/supplied run-id against the O2 grammar. */
export const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/;

/** Matches the trailing `-<hash12>` segment of a well-formed repo key. */
export const REPO_KEY_HASH_TAIL = /-[0-9a-f]{12}$/;

/** Optional dependency seam so tests can isolate `os.homedir` / `process.env`. */
export interface StoreEnv {
  /** Defaults to `os.homedir()`. */
  homedir?: () => string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function resolveHomedir(deps?: StoreEnv): string {
  return (deps?.homedir ?? os.homedir)();
}

function resolveEnv(deps?: StoreEnv): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

/**
 * Read the install-time marker contents, or `undefined` if it is absent or
 * empty. The marker's single line is the configured store-root path.
 */
function readStoreMarker(deps?: StoreEnv): string | undefined {
  const markerPath = path.join(resolveHomedir(deps), STORE_MARKER_RELPATH);
  if (!existsSync(markerPath)) return undefined;
  try {
    const contents = readFileSync(markerPath, 'utf8').trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the store root, highest precedence first:
 *   1. `GAN_RUNS_DATA` environment variable (single-run override; testing / CI).
 *   2. The path recorded at install time in `~/.claude/gan/runs-data-dir`.
 *   3. Default `<homedir>/.gan-runs-data`.
 *
 * The returned path is always absolute with the home directory expanded — never
 * a literal `~`. The default form joins `os.homedir()` so the result starts
 * with the home directory. The env/marker forms are resolved to absolute paths
 * (relative to the home directory if not already absolute) so callers always
 * receive an absolute store root.
 */
export function resolveStoreRoot(deps?: StoreEnv): string {
  const home = resolveHomedir(deps);
  const env = resolveEnv(deps);

  const fromEnv = env[STORE_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return absolutize(fromEnv.trim(), home);
  }

  const fromMarker = readStoreMarker(deps);
  if (fromMarker !== undefined) {
    return absolutize(fromMarker, home);
  }

  return path.join(home, DEFAULT_STORE_DIRNAME);
}

/**
 * Expand a configured store path to an absolute form. A leading `~` is expanded
 * to the home directory (never left as a literal `~`); a relative path is
 * resolved against the home directory; an absolute path is normalised.
 */
function absolutize(p: string, home: string): string {
  let expanded = p;
  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2));
  }
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(home, expanded);
}

/**
 * Resolve the repo's **main-worktree root** — the parent of
 * `git rev-parse --git-common-dir`, NOT `git rev-parse --show-toplevel`. All
 * linked worktrees of a repo share one git-common-dir, so from inside any
 * linked worktree this resolves to the original main checkout, not the
 * worktree directory. That shared anchor is what makes the repo key (and
 * therefore the central store directory) identical across all worktrees.
 *
 * The git invocation uses `execFileSync` with an argv array and a `cwd`; no
 * path or env value is interpolated into a shell command line.
 *
 * @param fromDir directory inside the repo (worktree or main checkout) to run
 *   git from. Defaults to `process.cwd()`.
 * @param exec    injectable for tests; defaults to `execFileSync`.
 */
export function resolveMainWorktreeRoot(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {
  // Adapt the execFileSync-style seam to the shared `GitExec` seam and delegate
  // to the single git-common-dir → main-root derivation (one implementation,
  // shared with the worktree resolver, including the empty-output guard).
  const git: GitExec = (args, cwd) =>
    exec('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return deriveMainWorktreeRoot(git, fromDir);
}

/**
 * Compute the repo key for a given main-worktree root path: `<basename>-<hash12>`.
 *
 *   - `basename` is the main-worktree directory name (for human browsability).
 *   - `hash12` is the first 12 lowercase hex characters of the SHA-256 of the
 *     **canonical** main-worktree path (case-folding {@link canonicalizePath}),
 *     so two linked worktrees — and two spellings differing only by case or a
 *     trailing slash on a case-insensitive filesystem — produce the same key.
 *
 * The basename is derived from the canonical (case-folded on darwin/win32) path
 * so the human-facing prefix stays stable alongside the hash for the same repo.
 */
export function computeRepoKey(mainWorktreeRoot: string): string {
  const canonical = canonicalizePath(mainWorktreeRoot);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  const basename = path.basename(canonical);
  return `${basename}-${hash}`;
}

/**
 * Convenience: derive the repo key directly from a directory inside the repo
 * (worktree or main checkout). Resolves the main-worktree root via
 * `git rev-parse --git-common-dir` then keys it.
 */
export function resolveRepoKey(
  fromDir: string = process.cwd(),
  exec: typeof execFileSync = execFileSync,
): string {
  return computeRepoKey(resolveMainWorktreeRoot(fromDir, exec));
}

/** The per-repo store directory: `<store-root>/<repo-key>/`. */
export function resolveRepoStoreDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

/** The repo-level serialization lock path: `<store-root>/<repo-key>/run.lock` (O2 owns its use). */
export function resolveRunLockPath(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'run.lock');
}

/** The repo's runs container: `<store-root>/<repo-key>/runs/`. */
export function resolveRunsRoot(storeRoot: string, repoKey: string): string {
  return path.join(resolveRepoStoreDir(storeRoot, repoKey), 'runs');
}

/**
 * The per-run directory: `<store-root>/<repo-key>/runs/<run-id>/`. This is the
 * relocation target — it replaces `<projectRoot>/.gan-state/runs/<run-id>/`.
 * The per-run *internal* layout is unchanged (O2 owns it).
 */
export function resolveRunDir(storeRoot: string, repoKey: string, runId: string): string {
  return path.join(resolveRunsRoot(storeRoot, repoKey), runId);
}

/** All resolved store paths for a run, in one object. */
export interface ResolvedRunStore {
  /** The resolved store root (env > marker > default), absolute. */
  storeRoot: string;
  /** `<basename>-<hash12>` for the repo. */
  repoKey: string;
  /** The main-worktree root the key was derived from, resolved absolute. */
  mainWorktreeRoot: string;
  /** `<store-root>/<repo-key>/`. */
  repoStoreDir: string;
  /** `<store-root>/<repo-key>/run.lock`. */
  runLockPath: string;
  /** `<store-root>/<repo-key>/runs/`. */
  runsRoot: string;
  /** `<store-root>/<repo-key>/runs/<run-id>/`. */
  runDir: string;
}

/**
 * One-shot resolution of every central-store path for a run. Resolves the
 * store root by precedence, derives the main-worktree root (and therefore the
 * repo key) from the invocation directory's git-common-dir, and assembles the
 * per-run directory.
 */
export function resolveRunStore(opts: {
  runId: string;
  /** Directory inside the repo to resolve the key from. Defaults to cwd. */
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
 * Generate a fresh run-id in the O2 grammar `<YYYYMMDDTHHMMSS>-<4 hex>` (UTC).
 * The form is unchanged from O2; this slice only relocates the directory the
 * id names.
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

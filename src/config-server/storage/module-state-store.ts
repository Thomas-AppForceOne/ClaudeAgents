

/**
 * Path resolution for the module-state store — the central, per-repository
 * directory where modules persist their state across `/gan` runs.
 *
 * Module state is keyed by *repository*, not by worktree: every linked worktree
 * of a repo shares one state directory, identified by the repo key derived from
 * the main worktree root (see {@link computeRepoKey}). The store root itself is
 * resolved by the shared precedence rule (env var → marker file → default
 * dirname under home), which this module specialises for module state with the
 * `GAN_MODULE_STATE` env var and `.gan-module-state` default.
 *
 * This module mirrors {@link import('./run-store.js')} (run store) but for
 * module state, and re-exports the repo-key primitives from there so callers
 * have a single import surface.
 *
 * All functions here are pure path computation plus (cached) git reads to find
 * the main worktree root; none of them read or write state files.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  REPO_KEY_HASH_LENGTH,
  REPO_KEY_HASH_TAIL,
  computeRepoKey,
  resolveMainWorktreeRoot,
} from './run-store.js';
import { resolveStoreRootByPrecedence, type StoreEnv } from './store-common.js';

export { REPO_KEY_HASH_LENGTH, REPO_KEY_HASH_TAIL, computeRepoKey, resolveMainWorktreeRoot };
export type { StoreEnv } from './store-common.js';

// Cache of fromDir → main-worktree-root. Resolving the main worktree shells out
// to git; module-state paths are computed often, so the result is memoised per
// starting directory. Only used for the default (non-injected) executor.
const mainWorktreeRootCache = new Map<string, string>();

/**
 * Clear the main-worktree-root cache. Test-only (`_` prefix): tests that move
 * or recreate repositories between cases must drop stale cached roots.
 */
export function _resetModuleRepoKeyCacheForTests(): void {
  mainWorktreeRootCache.clear();
}

/**
 * Resolve the main worktree root for `fromDir`, caching the result.
 *
 * When a custom `exec` is supplied (tests), the cache is bypassed entirely —
 * the injected executor's behaviour may differ per call, so caching it would
 * leak one test's git stub into another. The production path (no `exec`) caches.
 */
function moduleMainWorktreeRoot(fromDir: string, exec?: typeof execFileSync): string {
  if (exec !== undefined) return resolveMainWorktreeRoot(fromDir, exec);
  let mainRoot = mainWorktreeRootCache.get(fromDir);
  if (mainRoot === undefined) {
    mainRoot = resolveMainWorktreeRoot(fromDir);
    mainWorktreeRootCache.set(fromDir, mainRoot);
  }
  return mainRoot;
}

/**
 * Compute the repo key (stable per-repository identity) used to namespace
 * module state, starting from `fromDir`.
 *
 * @param fromDir a directory inside the repo; defaults to `process.cwd()`.
 * @param exec optional git executor override (tests); bypasses the root cache.
 * @returns the repo key (`<basename>-<hash>`), shared across the repo's
 *   worktrees.
 * @throws propagates if the main worktree root cannot be resolved (not a repo).
 */
export function resolveModuleRepoKey(
  fromDir: string = process.cwd(),
  exec?: typeof execFileSync,
): string {
  return computeRepoKey(moduleMainWorktreeRoot(fromDir, exec));
}

/** Default module-state directory name under the user's home, when neither the
 * env var nor a marker file overrides the location. */
export const DEFAULT_MODULE_STATE_DIRNAME = '.gan-module-state';

/** Home-relative path of the marker file that, if present, redirects the
 * module-state store root to the path it contains. */
export const MODULE_STATE_MARKER_RELPATH = path.join('.claude', 'gan', 'module-state-dir');

/** Environment variable that, when set, takes top precedence for the
 * module-state store root. */
export const MODULE_STATE_ROOT_ENV = 'GAN_MODULE_STATE';

/**
 * Resolve the module-state store root by the standard precedence:
 * `GAN_MODULE_STATE` env var → marker file → `~/.gan-module-state`.
 *
 * @param deps optional environment seams (`homedir`/`env`) for tests.
 * @returns the absolute store root directory.
 */
export function resolveModuleStateRoot(deps?: StoreEnv): string {
  return resolveStoreRootByPrecedence(
    {
      envVar: MODULE_STATE_ROOT_ENV,
      markerRelpath: MODULE_STATE_MARKER_RELPATH,
      defaultDirname: DEFAULT_MODULE_STATE_DIRNAME,
    },
    deps,
  );
}

/** The per-repository module-state directory: `<storeRoot>/<repoKey>`. */
export function resolveRepoModuleStateDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

/** The per-module directory within a repo's state dir:
 * `<storeRoot>/<repoKey>/<name>`. */
export function resolveModuleDir(storeRoot: string, repoKey: string, name: string): string {
  return path.join(resolveRepoModuleStateDir(storeRoot, repoKey), name);
}

/**
 * Injection seams for module-state path resolution.
 *
 * @property deps environment seams (`homedir`/`env`) used to resolve the store
 *   root.
 * @property exec git executor override used to resolve the repo key (bypasses
 *   the worktree-root cache).
 */
export interface ModuleStateStoreOptions {

  deps?: StoreEnv;

  exec?: typeof execFileSync;
}

/**
 * Resolve the absolute path of a module's state file for one key:
 * `<storeRoot>/<repoKey>/<name>/<key>.json`.
 *
 * @param name owning module.
 * @param key the state key (filename stem).
 * @param fromDir directory inside the repo; defaults to `process.cwd()`.
 * @param opts optional store/repo-key seams.
 * @returns the absolute file path. Pure path computation (plus a git read to
 *   find the repo key); no file is created or read.
 */
export function resolveModuleStatePath(
  name: string,
  key: string,
  fromDir: string = process.cwd(),
  opts: ModuleStateStoreOptions = {},
): string {
  const storeRoot = resolveModuleStateRoot(opts.deps);
  const repoKey = resolveModuleRepoKey(fromDir, opts.exec);
  return path.join(resolveModuleDir(storeRoot, repoKey, name), `${key}.json`);
}

/**
 * The fully-resolved module-state store locations for a repository.
 *
 * @property storeRoot the resolved store root directory.
 * @property repoKey the per-repository key.
 * @property mainWorktreeRoot the repo's main worktree root the key derives from.
 * @property repoModuleStateDir `<storeRoot>/<repoKey>`, the repo's state dir.
 */
export interface ResolvedModuleStateStore {

  storeRoot: string;

  repoKey: string;

  mainWorktreeRoot: string;

  repoModuleStateDir: string;
}

/**
 * Resolve every module-state store location for a repository in one call.
 *
 * @param opts.fromDir directory inside the repo; defaults to `process.cwd()`.
 * @param opts.deps environment seams for the store root.
 * @param opts.exec git executor override for the repo key.
 * @returns a {@link ResolvedModuleStateStore} bundling root, key, main worktree
 *   root, and the repo state dir.
 * @throws propagates if the main worktree root cannot be resolved.
 */
export function resolveModuleStateStore(opts: {

  fromDir?: string;
  deps?: StoreEnv;
  exec?: typeof execFileSync;
}): ResolvedModuleStateStore {
  const storeRoot = resolveModuleStateRoot(opts.deps);
  const mainWorktreeRoot = moduleMainWorktreeRoot(opts.fromDir ?? process.cwd(), opts.exec);
  const repoKey = computeRepoKey(mainWorktreeRoot);
  return {
    storeRoot,
    repoKey,
    mainWorktreeRoot,
    repoModuleStateDir: resolveRepoModuleStateDir(storeRoot, repoKey),
  };
}

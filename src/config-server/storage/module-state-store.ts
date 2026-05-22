/**
 * F8 slice 1 — central, repo-keyed module-state store resolution.
 *
 * Durable cross-run **module state** (notably M2's Docker `port-registry.json`)
 * moves out of the project tree's gitignored `<projectRoot>/.gan-state/modules/`
 * into a central, repo-keyed store outside any worktree. That relocation makes
 * the store survive `git worktree remove` of the worktree it was first written
 * from, and — because every linked worktree of one repo shares a single
 * git-common-dir — it makes all worktrees of a repo resolve to the SAME store
 * sub-directory, which is what finally makes M2's cross-worktree non-collision
 * guarantee hold (the central correctness fix F8 exists for).
 *
 * Layout (per the F8 spec §1):
 *
 *   <module-state-root>/
 *     <repo-key>/                        one directory per repo (F7's key)
 *       docker/
 *         port-registry.json             M2 registry, now shared repo-wide
 *
 * Kept deliberately SEPARATE from F7's run-data store: run data is per-run,
 * agent-written, and cleaned by `--cleanup`; module state is durable cross-run,
 * server-written, and never cleaned. The two roots are siblings under home
 * (`~/.gan-module-state` vs `~/.gan-runs-data`) but never the same path, and
 * their env overrides differ (`GAN_MODULE_STATE` vs `GAN_RUNS_DATA`).
 *
 * REUSE-OR-JUSTIFY: this module deliberately does NOT re-implement the F7
 * derivation it depends on. The repo-key (`<basename>-<hash12>` of the canonical
 * main-worktree root), the git-common-dir → main-worktree-root resolution, the
 * SHA-256 keying, and the case-folding all come from `run-store.ts` /
 * `git-exec.ts` / the determinism module. The store-root precedence ladder,
 * tilde/relative absolutization, and marker reading come from the shared
 * `store-common.ts` (the same primitives `run-store.ts`'s `resolveStoreRoot`
 * uses). The only F8-specific additions here are the env-var name, marker
 * relpath, default dirname, and the per-module/per-key path tail.
 *
 * Subprocess safety (`shell_and_subprocess_safety`): the single git invocation
 * behind repo-key derivation runs through the shared `GitExec` argv-array seam
 * (`execFileSync('git', argv, { cwd })`); no worktree path or env value is ever
 * interpolated into a shell command line.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  REPO_KEY_HASH_LENGTH,
  REPO_KEY_HASH_TAIL,
  computeRepoKey,
  resolveMainWorktreeRoot,
  resolveRepoKey,
} from './run-store.js';
import { resolveStoreRootByPrecedence, type StoreEnv } from './store-common.js';

// Re-export the F7 repo-key derivation so module-state callers depend on this
// store as their single entry point without reaching back into run-store for
// the key. These are the SAME functions F7 ships — re-exported, not copied.
export { REPO_KEY_HASH_LENGTH, REPO_KEY_HASH_TAIL, computeRepoKey, resolveMainWorktreeRoot };
export { resolveRepoKey as resolveModuleRepoKey };
export type { StoreEnv } from './store-common.js';

/**
 * Default module-state store-root directory name under the user's home
 * directory. Deliberately DISTINCT from run-store's `DEFAULT_STORE_DIRNAME`
 * (`.gan-runs-data`): the two are siblings under home, never the same path.
 */
export const DEFAULT_MODULE_STATE_DIRNAME = '.gan-module-state';

/**
 * Install-time marker file (relative to the user's home directory) recording
 * the configured module-state root. `install.sh` writes it (a later F8 slice);
 * the config server reads it here. `GAN_MODULE_STATE` overrides it.
 *
 * Distinct from run-store's `STORE_MARKER_RELPATH` (`.claude/gan/runs-data-dir`)
 * — module state has its own marker because it has its own lifecycle.
 */
export const MODULE_STATE_MARKER_RELPATH = path.join('.claude', 'gan', 'module-state-dir');

/** Environment variable that overrides the module-state root. */
export const MODULE_STATE_ROOT_ENV = 'GAN_MODULE_STATE';

/**
 * Resolve the module-state store root, highest precedence first:
 *   1. `GAN_MODULE_STATE` environment variable (override; testing / CI).
 *      An empty or whitespace-only value is treated as absent and falls
 *      through to the next source.
 *   2. The path recorded at install time in `~/.claude/gan/module-state-dir`.
 *   3. Default `<homedir>/.gan-module-state`.
 *
 * The returned path is always absolute with the home directory expanded — never
 * a literal `~`; a leading `~`/`~/` expands to home, a relative path resolves
 * against home, an absolute path is normalised. Delegates to the SAME shared
 * {@link resolveStoreRootByPrecedence} ladder F7's run-store uses, passing only
 * the module-state knobs.
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

/** The per-repo module-state directory: `<module-state-root>/<repo-key>/`. */
export function resolveRepoModuleStateDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

/**
 * The per-module directory: `<module-state-root>/<repo-key>/<module>/`. This is
 * the relocation target — it replaces `<projectRoot>/.gan-state/modules/<name>/`.
 * `listInstalledModules` scans the parent of these directories.
 */
export function resolveModuleDir(storeRoot: string, repoKey: string, name: string): string {
  return path.join(resolveRepoModuleStateDir(storeRoot, repoKey), name);
}

/** Optional injection seam for the path resolvers below. */
export interface ModuleStateStoreOptions {
  /** Home/env seam, forwarded to {@link resolveModuleStateRoot}. */
  deps?: StoreEnv;
  /** Git exec seam, forwarded to the F7 repo-key derivation; defaults to `execFileSync`. */
  exec?: typeof execFileSync;
}

/**
 * Resolve the on-disk state file for a module + state key:
 * `<module-state-root>/<repo-key>/<name>/<key>.json`.
 *
 * `<repo-key>` is F7's `<basename>-<hash12>` derived from the canonical
 * main-worktree root, resolved from `fromDir` via the F7 git-common-dir helper
 * (reused, not re-derived). All linked worktrees of one repo therefore resolve
 * to the SAME path, and two spellings of the main-worktree root differing only
 * by case or a trailing slash key to the same directory.
 *
 * @param name    the module name (its own sub-directory).
 * @param key     the state key (its own file; `<key>.json`).
 * @param fromDir a directory inside the repo used to derive the repo-key.
 *                Defaults to `process.cwd()`.
 * @param opts    optional home/env and git injection seams (tests).
 */
export function resolveModuleStatePath(
  name: string,
  key: string,
  fromDir: string = process.cwd(),
  opts: ModuleStateStoreOptions = {},
): string {
  const storeRoot = resolveModuleStateRoot(opts.deps);
  const repoKey = resolveRepoKey(fromDir, opts.exec);
  return path.join(resolveModuleDir(storeRoot, repoKey, name), `${key}.json`);
}

/** All resolved module-state paths for a repo, in one object. */
export interface ResolvedModuleStateStore {
  /** The resolved store root (env > marker > default), absolute. */
  storeRoot: string;
  /** `<basename>-<hash12>` for the repo (F7's key). */
  repoKey: string;
  /** The main-worktree root the key was derived from, resolved absolute. */
  mainWorktreeRoot: string;
  /** `<module-state-root>/<repo-key>/`. */
  repoModuleStateDir: string;
}

/**
 * One-shot resolution of the repo-level module-state paths: resolves the store
 * root by precedence and derives the main-worktree root (and therefore the
 * repo key) from `fromDir`'s git-common-dir. Per-module / per-key paths are then
 * cheap joins (or use {@link resolveModuleStatePath} directly).
 */
export function resolveModuleStateStore(opts: {
  /** Directory inside the repo to resolve the key from. Defaults to cwd. */
  fromDir?: string;
  deps?: StoreEnv;
  exec?: typeof execFileSync;
}): ResolvedModuleStateStore {
  const storeRoot = resolveModuleStateRoot(opts.deps);
  const mainWorktreeRoot = resolveMainWorktreeRoot(opts.fromDir, opts.exec);
  const repoKey = computeRepoKey(mainWorktreeRoot);
  return {
    storeRoot,
    repoKey,
    mainWorktreeRoot,
    repoModuleStateDir: resolveRepoModuleStateDir(storeRoot, repoKey),
  };
}

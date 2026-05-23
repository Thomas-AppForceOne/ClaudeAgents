

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

const mainWorktreeRootCache = new Map<string, string>();

export function _resetModuleRepoKeyCacheForTests(): void {
  mainWorktreeRootCache.clear();
}

function moduleMainWorktreeRoot(fromDir: string, exec?: typeof execFileSync): string {
  if (exec !== undefined) return resolveMainWorktreeRoot(fromDir, exec);
  let mainRoot = mainWorktreeRootCache.get(fromDir);
  if (mainRoot === undefined) {
    mainRoot = resolveMainWorktreeRoot(fromDir);
    mainWorktreeRootCache.set(fromDir, mainRoot);
  }
  return mainRoot;
}

export function resolveModuleRepoKey(
  fromDir: string = process.cwd(),
  exec?: typeof execFileSync,
): string {
  return computeRepoKey(moduleMainWorktreeRoot(fromDir, exec));
}

export const DEFAULT_MODULE_STATE_DIRNAME = '.gan-module-state';

export const MODULE_STATE_MARKER_RELPATH = path.join('.claude', 'gan', 'module-state-dir');

export const MODULE_STATE_ROOT_ENV = 'GAN_MODULE_STATE';

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

export function resolveRepoModuleStateDir(storeRoot: string, repoKey: string): string {
  return path.join(storeRoot, repoKey);
}

export function resolveModuleDir(storeRoot: string, repoKey: string, name: string): string {
  return path.join(resolveRepoModuleStateDir(storeRoot, repoKey), name);
}

export interface ModuleStateStoreOptions {

  deps?: StoreEnv;

  exec?: typeof execFileSync;
}

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

export interface ResolvedModuleStateStore {

  storeRoot: string;

  repoKey: string;

  mainWorktreeRoot: string;

  repoModuleStateDir: string;
}

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

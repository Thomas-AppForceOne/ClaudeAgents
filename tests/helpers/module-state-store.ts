/**
 * Shared test helpers for the F8 repo-keyed module-state store.
 *
 * After F8, module state lives at `<module-state-root>/<repo-key>/<name>/<key>.json`,
 * where the repo-key is derived from the project root via `git rev-parse
 * --git-common-dir`. Tests that previously used a bare temp dir as the project
 * root (and asserted `<projectRoot>/.gan-state/modules/...`) must now:
 *
 *   1. make that temp dir a real git repo (so the repo-key derivation succeeds), and
 *   2. point `GAN_MODULE_STATE` at a throwaway store root (so writes land in a
 *      temp tree, not the user's real `~/.gan-module-state`).
 *
 * These helpers package both steps so each test file states the intent once.
 * They mutate `process.env.GAN_MODULE_STATE` for the production seam (which the
 * tools read through `process.env` when no ctx override is supplied), and expose
 * the resolved repo-keyed path so assertions target the real on-disk shape.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MODULE_STATE_ROOT_ENV,
  resolveModuleStatePath,
} from '../../src/config-server/storage/module-state-store.js';

/** Run git with an argv array (never a shell string) inside `cwd`. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

/**
 * Initialise `dir` as a minimal git repository so the F8 repo-key derivation
 * (`git rev-parse --git-common-dir`) resolves from it. Signing is disabled and
 * an initial commit is created so the repo is fully usable.
 */
export function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
}

/**
 * A scoped temp module-state store: a throwaway root exported via
 * `GAN_MODULE_STATE`. Call {@link ModuleStateStoreScope.restore} in `afterEach`
 * to put the environment back.
 */
export interface ModuleStateStoreScope {
  /** The temp store root now pointed at by `GAN_MODULE_STATE`. */
  storeRoot: string;
  /** Resolve the repo-keyed state path a write to `(name, key)` from `projectRoot` lands at. */
  statePath: (projectRoot: string, name: string, key: string) => string;
  /** Restore `GAN_MODULE_STATE` to its prior value. */
  restore: () => void;
}

/**
 * Point `GAN_MODULE_STATE` at a fresh temp store root for the duration of a
 * test. The returned `statePath` helper computes the exact repo-keyed file a
 * write would land at, using the same production resolver the tools use, so
 * assertions stay in lockstep with the implementation.
 */
export function useTempModuleStateStore(): ModuleStateStoreScope {
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'cas-module-state-'));
  const prior = process.env[MODULE_STATE_ROOT_ENV];
  process.env[MODULE_STATE_ROOT_ENV] = storeRoot;

  return {
    storeRoot,
    statePath: (projectRoot, name, key) =>
      resolveModuleStatePath(name, key, projectRoot, { deps: { env: process.env } }),
    restore: () => {
      if (prior === undefined) {
        delete process.env[MODULE_STATE_ROOT_ENV];
      } else {
        process.env[MODULE_STATE_ROOT_ENV] = prior;
      }
    },
  };
}

// Shared test helpers for exercising the module-state store and the git
// repo/worktree topology its repo-key derivation depends on. Two concerns live
// here: (a) building throwaway git repos and linked worktrees so tests can
// observe that module state is keyed per *repository* (shared across worktrees),
// and (b) redirecting the store root to a temp dir via the env-var seam so a
// test never touches the developer's real `~/.gan-module-state`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MODULE_STATE_ROOT_ENV,
  resolveModuleStatePath,
} from '../../src/config-server/storage/module-state-store.js';

// Run git in `cwd` with stdout captured and stderr discarded. Used only by the
// helpers below to script repo setup; failures surface as a thrown exec error.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

/**
 * Initialise `dir` as a self-contained git repo with one empty commit.
 *
 * Identity and signing are configured locally (not relying on the developer's
 * global git config) so the repo is hermetic, and gpg signing is disabled so
 * the commit never blocks on a key/passphrase. The single empty commit gives
 * the repo a HEAD, which `git worktree add` and repo-key derivation require.
 *
 * @param dir an existing directory to turn into a repo root.
 */
export function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
}

/**
 * Add a linked git worktree of `mainRepoDir` at `worktreePath` on a new branch.
 *
 * Used to assert that module state is shared across worktrees of one repo: the
 * derived repo key comes from the main worktree root, so a worktree resolves to
 * the same state directory as its main repo.
 *
 * @param mainRepoDir the existing main worktree (repo root).
 * @param worktreePath path to create the new worktree at (must not yet exist).
 * @param branch name of the new branch to create for the worktree.
 */
export function addGitWorktree(mainRepoDir: string, worktreePath: string, branch: string): void {
  git(mainRepoDir, ['worktree', 'add', '-q', '-b', branch, worktreePath]);
}

/**
 * Remove a previously-added worktree. `--force` so a dirty or busy worktree is
 * still torn down during test cleanup rather than leaving git metadata behind.
 *
 * @param mainRepoDir the main worktree that owns the linked worktree.
 * @param worktreePath the worktree to remove.
 */
export function removeGitWorktree(mainRepoDir: string, worktreePath: string): void {
  git(mainRepoDir, ['worktree', 'remove', '--force', worktreePath]);
}

/**
 * A scoped redirection of the module-state store to a temp directory.
 *
 * @property storeRoot the temp store root the env var now points at; assert
 *   against this to confirm where state landed.
 * @property statePath resolve the on-disk path a `(projectRoot, name, key)`
 *   tuple maps to under this scope, threading the live `process.env` so the
 *   redirected root is honoured.
 * @property restore undo the env-var override, putting back any prior value (or
 *   deleting it if there was none). Call in test teardown to avoid leaking the
 *   override into sibling tests.
 */
export interface ModuleStateStoreScope {

  storeRoot: string;

  statePath: (projectRoot: string, name: string, key: string) => string;

  restore: () => void;
}

/**
 * Point the module-state store root at a fresh temp directory for the duration
 * of a test, returning a {@link ModuleStateStoreScope} to query and tear it down.
 *
 * The redirection is via the `GAN_MODULE_STATE` env var (top-precedence seam),
 * so no real home directory is touched. The prior env value is captured up front
 * and reinstated by `restore()` — distinguishing "was unset" from "was empty
 * string" so teardown is exact.
 *
 * @returns the scope; the caller is responsible for invoking `restore()`.
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

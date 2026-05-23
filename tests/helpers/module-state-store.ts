

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MODULE_STATE_ROOT_ENV,
  resolveModuleStatePath,
} from '../../src/config-server/storage/module-state-store.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

export function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
}

export function addGitWorktree(mainRepoDir: string, worktreePath: string, branch: string): void {
  git(mainRepoDir, ['worktree', 'add', '-q', '-b', branch, worktreePath]);
}

export function removeGitWorktree(mainRepoDir: string, worktreePath: string): void {
  git(mainRepoDir, ['worktree', 'remove', '--force', worktreePath]);
}

export interface ModuleStateStoreScope {

  storeRoot: string;

  statePath: (projectRoot: string, name: string, key: string) => string;

  restore: () => void;
}

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

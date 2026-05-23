

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  canonicalizePath,
  canonicalizePathForDisplay,
} from '../../../src/config-server/determinism/index.js';
import {
  resolveRepoKey,
  resolveRunLockPath,
  resolveRunsRoot,
  resolveStoreRoot,
} from '../../../src/config-server/storage/run-store.js';
import {
  acquireRunLock,
  readRunLock,
  releaseRunLock,
} from '../../../src/config-server/storage/run-lock.js';
import { checkRecoveryAnchor } from '../../../src/config-server/storage/recovery-anchor.js';
import { enumerateRuns, findRun } from '../../../src/config-server/storage/run-enumerator.js';
import {
  checkActiveRunGuard,
  executeRunCleanup,
  isBranchMerged,
  planRunCleanup,
  type RunCleanupPlan,
} from '../../../src/config-server/storage/cleanup-planner.js';
import type { GitExec } from '../../../src/config-server/storage/worktree-resolver.js';
import type { EnumeratedRun } from '../../../src/config-server/storage/run-enumerator.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'cas-f7s4-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function initRepo(): string {
  const repo = makeTmp('cas-f7s4-repo-');
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function seedRun(
  storeRoot: string,
  repoKey: string,
  runId: string,
  progress: Record<string, unknown>,
): string {
  const runsRoot = resolveRunsRoot(storeRoot, repoKey);
  const runDir = path.join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'progress.json'),
    JSON.stringify({ runId, ...progress }, null, 2) + '\n',
    'utf8',
  );
  return runDir;
}

const DEAD_PID = 2147483646;

describe('run lock — anchored on the central store', () => {
  it('run_lock_anchored_on_central_store: lock path is <repo-key>/run.lock, not .gan-state/run.lock', () => {
    const main = initRepo();
    const storeRoot = makeTmp('cas-f7s4-store-');
    const home = makeTmp('cas-f7s4-home-');
    const repoKey = resolveRepoKey(main);

    const resolvedStore = resolveStoreRoot({
      homedir: () => home,
      env: { GAN_RUNS_DATA: storeRoot },
    });
    const lockPath = resolveRunLockPath(resolvedStore, repoKey);

    expect(lockPath).toBe(resolveRunLockPath(storeRoot, repoKey));
    expect(lockPath).toContain(`${repoKey}${path.sep}run.lock`);
    expect(lockPath).not.toContain(`.gan-state${path.sep}run.lock`);
  });

  it('run_lock_anchored_on_central_store: acquire writes {runId,pid,startedAt,hostname}; release deletes', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const lockPath = path.join(storeRoot, 'myrepo-aaaaaaaaaaaa', 'run.lock');

    const handle = acquireRunLock({ lockPath, runId: '20260522T180000-aaaa' });
    expect(existsSync(lockPath)).toBe(true);
    const parsed = readRunLock(lockPath);
    expect(parsed).toBeDefined();
    expect(parsed!.runId).toBe('20260522T180000-aaaa');
    expect(typeof parsed!.pid).toBe('number');
    expect(typeof parsed!.startedAt).toBe('string');
    expect(parsed!.startedAt.length).toBeGreaterThan(0);
    expect(typeof parsed!.hostname).toBe('string');

    releaseRunLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('concurrent run — refused across two worktrees of the same repo', () => {
  it('concurrent_run_refused_across_worktrees: live holder from wtA blocks wtB, names runId+pid', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const home = makeTmp('cas-f7s4-home-');
    const main = initRepo();
    const wtB = path.join(makeTmp('cas-f7s4-wtb-'), 'linked');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/b', wtB]);

    const keyMain = resolveRepoKey(main);
    const keyWtB = resolveRepoKey(wtB);
    expect(keyMain).toBe(keyWtB);

    const env = { homedir: () => home, env: { GAN_RUNS_DATA: storeRoot } } as const;
    const lockMain = resolveRunLockPath(resolveStoreRoot(env), keyMain);
    const lockWtB = resolveRunLockPath(resolveStoreRoot(env), keyWtB);
    expect(lockWtB).toBe(lockMain);

    const handle = acquireRunLock({ lockPath: lockMain, runId: '20260522T180000-aaaa' });

    let threw: unknown;
    try {
      acquireRunLock({ lockPath: lockWtB, runId: '20260522T180000-bbbb' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    const err = threw as Record<string, unknown> & { message: string };
    expect(err.reason).toBe('ConcurrentRunInProgress');
    expect(err.runId).toBe('20260522T180000-aaaa');
    expect(err.pid).toBe(process.pid);
    expect(err.message).toContain('20260522T180000-aaaa');
    expect(err.message).toContain(String(process.pid));

    releaseRunLock(handle);
    const handleB = acquireRunLock({ lockPath: lockWtB, runId: '20260522T180000-bbbb' });
    expect(readRunLock(lockWtB)!.runId).toBe('20260522T180000-bbbb');
    releaseRunLock(handleB);
  });

  it('concurrent_run_refused_across_worktrees: a stale lock (dead pid) is broken + acquisition proceeds', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const lockPath = path.join(storeRoot, 'r-aaaaaaaaaaaa', 'run.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });

    writeFileSync(
      lockPath,
      JSON.stringify({
        runId: '20260522T170000-dead',
        pid: DEAD_PID,
        startedAt: '2026-05-22T17:00:00Z',
        hostname: 'old',
      }) + '\n',
      'utf8',
    );

    const warnings: string[] = [];
    const handle = acquireRunLock({
      lockPath,
      runId: '20260522T180000-live',
      warn: (l) => warnings.push(l),
    });

    expect(readRunLock(lockPath)!.runId).toBe('20260522T180000-live');
    expect(warnings.join('\n').toLowerCase()).toContain('stale');
    releaseRunLock(handle);
  });
});

describe('enumeration — repo-wide, read-only, same from any worktree', () => {
  it('enumeration_repo_wide_from_any_worktree: same run-id set from main and a linked worktree', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const main = initRepo();
    const wtB = path.join(makeTmp('cas-f7s4-wtb-'), 'linked');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/b', wtB]);

    const keyMain = resolveRepoKey(main);
    const keyWtB = resolveRepoKey(wtB);
    expect(keyMain).toBe(keyWtB);

    const ids = ['20260522T180000-0001', '20260522T180000-0002', '20260522T180000-0003'];
    for (const id of ids) {
      seedRun(storeRoot, keyMain, id, {
        projectRoot: canonicalizePath(main),
        workspace: { worktreePath: canonicalizePath(main), branch: 'develop', createdByGan: false },
      });
    }

    const runsRootMain = resolveRunsRoot(storeRoot, keyMain);
    const runsRootWtB = resolveRunsRoot(storeRoot, keyWtB);
    expect(runsRootWtB).toBe(runsRootMain);

    const fromMain = new Set(enumerateRuns(runsRootMain).map((r) => r.runId));
    const fromWtB = new Set(enumerateRuns(runsRootWtB).map((r) => r.runId));
    expect(fromMain).toEqual(new Set(ids));
    expect(fromWtB).toEqual(fromMain);
  });

  it('enumeration_repo_wide_from_any_worktree: read-only — every progress.json byte-identical after enumeration', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repoKey = 'r-aaaaaaaaaaaa';
    const id = '20260522T180000-0001';
    const runDir = seedRun(storeRoot, repoKey, id, {
      projectRoot: '/canonical/main',
      workspace: { worktreePath: '/canonical/main', branch: 'develop', createdByGan: false },
    });
    const progressPath = path.join(runDir, 'progress.json');
    const before = readFileSync(progressPath, 'utf8');

    const runs = enumerateRuns(resolveRunsRoot(storeRoot, repoKey));
    expect(runs).toHaveLength(1);
    expect(runs[0].projectRoot).toBe('/canonical/main');
    expect(runs[0].hasProgress).toBe(true);

    expect(readFileSync(progressPath, 'utf8')).toBe(before);
  });

  it('enumeration skips non-run directory entries', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repoKey = 'r-aaaaaaaaaaaa';
    const runsRoot = resolveRunsRoot(storeRoot, repoKey);
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(path.join(runsRoot, 'not-a-run'), { recursive: true });
    writeFileSync(path.join(runsRoot, 'stray.txt'), 'x', 'utf8');
    seedRun(storeRoot, repoKey, '20260522T180000-0001', {});
    const ids = enumerateRuns(runsRoot).map((r) => r.runId);
    expect(ids).toEqual(['20260522T180000-0001']);
  });
});

describe('recovery anchor — refuses from the wrong worktree', () => {
  it('recover_refuses_from_wrong_worktree_naming_path: refuses from wtOther naming wtOrigin+branch; still listed', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const main = initRepo();
    const wtOrigin = path.join(makeTmp('cas-f7s4-origin-'), 'origin');
    const wtOther = path.join(makeTmp('cas-f7s4-other-'), 'other');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/origin', wtOrigin]);
    git(main, ['worktree', 'add', '-q', '-b', 'feature/other', wtOther]);
    const repoKey = resolveRepoKey(main);

    const id = '20260522T180000-0001';
    seedRun(storeRoot, repoKey, id, {
      projectRoot: canonicalizePath(main),
      workspace: {
        worktreePath: canonicalizePath(wtOrigin),
        branch: 'feature/origin',
        createdByGan: true,
      },
    });

    const run = findRun(resolveRunsRoot(storeRoot, repoKey), id)!;
    const anchor = { worktreePath: run.workspace!.worktreePath!, branch: run.workspace!.branch! };

    const fromOther = checkRecoveryAnchor({ runId: id, workspace: anchor, fromDir: wtOther });
    expect(fromOther.ok).toBe(false);
    expect(fromOther.refusal).toBe('wrong-worktree');
    expect(fromOther.message).toBe(
      `Run ${id} was executed in worktree ${canonicalizePathForDisplay(wtOrigin)} ` +
        `(branch feature/origin); recover it from there.`,
    );

    const fromOrigin = checkRecoveryAnchor({ runId: id, workspace: anchor, fromDir: wtOrigin });
    expect(fromOrigin.ok).toBe(true);

    const listedFromOther = enumerateRuns(resolveRunsRoot(storeRoot, repoKey)).map((r) => r.runId);
    expect(listedFromOther).toContain(id);
  });

  it('recover_refuses_from_wrong_worktree_naming_path: missing recorded worktree refuses with recreate guidance', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const main = initRepo();
    const wtOrigin = path.join(makeTmp('cas-f7s4-origin-'), 'origin');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/origin', wtOrigin]);
    const repoKey = resolveRepoKey(main);
    const id = '20260522T180000-0001';
    const recordedPath = canonicalizePath(wtOrigin);
    seedRun(storeRoot, repoKey, id, {
      projectRoot: canonicalizePath(main),
      workspace: { worktreePath: recordedPath, branch: 'feature/origin', createdByGan: true },
    });

    git(main, ['worktree', 'remove', '--force', wtOrigin]);
    const elsewhere = makeTmp('cas-f7s4-elsewhere-');
    const res = checkRecoveryAnchor({
      runId: id,
      workspace: { worktreePath: recordedPath, branch: 'feature/origin' },
      fromDir: elsewhere,
    });
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('missing-worktree');
    expect(res.message).toContain(recordedPath);
    expect(res.message!.toLowerCase()).toContain('recreate');

    expect(enumerateRuns(resolveRunsRoot(storeRoot, repoKey)).map((r) => r.runId)).toContain(id);
  });

  it('recover_anchor_uses_canonical_comparison: trailing slash + case differences treated equal (darwin)', () => {
    const wt = makeTmp('cas-f7s4-canon-');
    const recorded = canonicalizePath(wt);

    const slashed = checkRecoveryAnchor({
      runId: 'r1',
      workspace: { worktreePath: recorded + path.sep, branch: 'b' },
      fromDir: wt,
    });
    expect(slashed.ok).toBe(true);

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const upper = checkRecoveryAnchor({
        runId: 'r1',
        workspace: { worktreePath: wt.toUpperCase(), branch: 'b' },
        fromDir: wt,
      });
      expect(upper.ok).toBe(true);
    }

    const sibling = makeTmp('cas-f7s4-sibling-');
    const diff = checkRecoveryAnchor({
      runId: 'r1',
      workspace: { worktreePath: recorded, branch: 'b' },
      fromDir: sibling,
    });
    expect(diff.ok).toBe(false);
    expect(diff.refusal).toBe('wrong-worktree');
  });
});

describe('cleanup — always removes the central-store run dir', () => {
  it('cleanup_always_removes_central_store_run_dir: targets the store path, not .gan-state/runs', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repoKey = 'r-aaaaaaaaaaaa';
    const id = '20260522T180000-0001';
    const runDir = seedRun(storeRoot, repoKey, id, {
      workspace: { worktreePath: '/canon/main', branch: 'develop', createdByGan: false },
    });
    expect(runDir.startsWith(storeRoot + path.sep)).toBe(true);
    expect(runDir).not.toContain(`.gan-state${path.sep}runs`);

    const run = findRun(resolveRunsRoot(storeRoot, repoKey), id)!;
    const plan = planRunCleanup(run, { fromDir: '/unused', git: () => '' });
    const outcome = executeRunCleanup(plan, { fromDir: '/unused', git: () => '', yes: true });

    expect(outcome.runDirRemoved).toBe(true);
    expect(existsSync(runDir)).toBe(false);
  });
});

describe('cleanup — merge-aware on a gan-created workspace (real git)', () => {

  function setupGanRun(opts: {
    storeRoot: string;
    merged: boolean;
    withRemote: boolean;
  }): { repo: string; repoKey: string; runId: string; branch: string; run: EnumeratedRun; runScoped: string } {
    const repo = initRepo();
    const branch = 'feature/task';
    const runId = '20260522T180000-7a5c';
    const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');

    git(repo, ['branch', branch, 'develop']);
    git(repo, ['worktree', 'add', '-q', runScoped, branch]);
    writeFileSync(path.join(runScoped, 'work.txt'), 'work\n', 'utf8');
    git(runScoped, ['add', 'work.txt']);
    git(runScoped, ['commit', '-q', '-m', 'task work']);

    if (opts.merged) {

      git(repo, ['merge', '-q', '--no-edit', branch]);
    }

    if (opts.withRemote) {
      const remoteDir = path.join(makeTmp('cas-f7s4-remote-'), 'remote.git');
      git(repo, ['init', '-q', '--bare', remoteDir]);
      git(repo, ['remote', 'add', 'origin', remoteDir]);

      git(runScoped, ['push', '-q', '-u', 'origin', branch]);
    }

    const repoKey = resolveRepoKey(repo);
    seedRun(opts.storeRoot, repoKey, runId, {
      baseBranch: 'develop',
      workspace: {
        worktreePath: canonicalizePath(runScoped),
        branch,
        createdByGan: true,
      },
    });
    const run = findRun(resolveRunsRoot(opts.storeRoot, repoKey), runId)!;
    return { repo, repoKey, runId, branch, run, runScoped };
  }

  function branchExists(repo: string, branch: string): boolean {
    return git(repo, ['branch', '--list', branch]).trim().length > 0;
  }

  it('cleanup_merge_aware_gan_worktree_and_branch: MERGED → worktree removed, branch deleted local+remote', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const { repo, branch, run, runScoped } = setupGanRun({ storeRoot, merged: true, withRemote: true });

    const argv: string[][] = [];
    const realGit: GitExec = (args, cwd) => {
      argv.push([...args]);
      return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    };

    const plan = planRunCleanup(run, { fromDir: repo, git: realGit, remote: 'origin' });
    expect(plan.branchPlan.kind).toBe('delete-merged');
    expect((plan.branchPlan as { remote?: string }).remote).toBe('origin');

    const outcome = executeRunCleanup(plan, {
      fromDir: repo,
      git: realGit,
      yes: true,
      warn: () => {},
    });

    expect(outcome.worktreeRemoved).toBe(true);
    expect(existsSync(runScoped)).toBe(false);
    expect(outcome.branchDeletedLocal).toBe(true);
    expect(branchExists(repo, branch)).toBe(false);
    expect(outcome.branchDeletedRemote).toBe(true);
    expect(outcome.runDirRemoved).toBe(true);

    assertMergeBeforeDelete(argv);

    expect(
      argv.some((a) => a[0] === 'push' && a.includes('--delete') && a.includes(branch)),
    ).toBe(true);
  });

  it('cleanup_merge_aware_gan_worktree_and_branch: UNMERGED without --yes → warns naming branch, no delete', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const { repo, branch, run, runScoped } = setupGanRun({ storeRoot, merged: false, withRemote: false });

    const argv: string[][] = [];
    const realGit: GitExec = (args, cwd) => {
      argv.push([...args]);
      return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    };
    const warnings: string[] = [];

    const plan = planRunCleanup(run, { fromDir: repo, git: realGit });
    expect(plan.branchPlan.kind).toBe('warn-unmerged');

    const outcome = executeRunCleanup(plan, {
      fromDir: repo,
      git: realGit,
      yes: false,
      warn: (l) => warnings.push(l),
    });

    expect(warnings.join('\n')).toContain(branch);
    expect(outcome.branchDeletedLocal).toBe(false);
    expect(branchExists(repo, branch)).toBe(true);
    expect(argv.some((a) => a[0] === 'branch' && a[1] === '-D')).toBe(false);
    expect(argv.some((a) => a[0] === 'push' && a.includes('--delete'))).toBe(false);

    expect(existsSync(runScoped)).toBe(false);
    expect(outcome.runDirRemoved).toBe(true);
  });

  it('cleanup_merge_aware_gan_worktree_and_branch: UNMERGED with --yes → warns AND deletes', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const { repo, branch, run } = setupGanRun({ storeRoot, merged: false, withRemote: false });

    const argv: string[][] = [];
    const realGit: GitExec = (args, cwd) => {
      argv.push([...args]);
      return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    };
    const warnings: string[] = [];

    const plan = planRunCleanup(run, { fromDir: repo, git: realGit });
    const outcome = executeRunCleanup(plan, {
      fromDir: repo,
      git: realGit,
      yes: true,
      warn: (l) => warnings.push(l),
    });

    expect(warnings.join('\n')).toContain(branch);
    expect(outcome.branchDeletedLocal).toBe(true);
    expect(git(repo, ['branch', '--list', branch]).trim()).toBe('');
    assertMergeBeforeDelete(argv);
  });

  function assertMergeBeforeDelete(argv: string[][]): void {
    const mergeIdx = argv.findIndex(
      (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'),
    );
    const deleteIdx = argv.findIndex(
      (a) => (a[0] === 'branch' && a[1] === '-D') || (a[0] === 'push' && a.includes('--delete')),
    );
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    if (deleteIdx >= 0) expect(mergeIdx).toBeLessThan(deleteIdx);
  }
});

describe('cleanup — never touches a user-owned (1a) workspace', () => {
  it('cleanup_never_touches_user_owned_workspace: createdByGan=false → only run dir removed; no git mutation', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repo = initRepo();

    const userWt = path.join(makeTmp('cas-f7s4-userwt-'), 'mine');
    git(repo, ['worktree', 'add', '-q', '-b', 'feature/mine', userWt]);
    const repoKey = resolveRepoKey(repo);
    const id = '20260522T180000-9f1e';
    const runDir = seedRun(storeRoot, repoKey, id, {
      workspace: { worktreePath: canonicalizePath(userWt), branch: 'feature/mine', createdByGan: false },
    });

    const argv: string[][] = [];
    const realGit: GitExec = (args, cwd) => {
      argv.push([...args]);
      return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    };

    const run = findRun(resolveRunsRoot(storeRoot, repoKey), id)!;
    const plan = planRunCleanup(run, { fromDir: repo, git: realGit });
    expect(plan.branchPlan.kind).toBe('none');

    const outcome = executeRunCleanup(plan, { fromDir: repo, git: realGit, yes: true });

    expect(outcome.runDirRemoved).toBe(true);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(userWt)).toBe(true);
    expect(git(repo, ['branch', '--list', 'feature/mine']).trim().length).toBeGreaterThan(0);

    expect(argv.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(argv.some((a) => a[0] === 'branch' && a[1] === '-D')).toBe(false);
    expect(argv.some((a) => a[0] === 'push' && a.includes('--delete'))).toBe(false);
  });
});

describe('cleanup — active-run guard on the central lock', () => {
  it('cleanup_active_run_guard_on_central_lock: live lock matching a target → refuse, names runId+pid, nothing removed', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repoKey = 'r-aaaaaaaaaaaa';
    const id = '20260522T180000-11ee';
    const runDir = seedRun(storeRoot, repoKey, id, {});
    const lockPath = resolveRunLockPath(storeRoot, repoKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });

    writeFileSync(
      lockPath,
      JSON.stringify({ runId: id, pid: process.pid, startedAt: 'now', hostname: 'h' }) + '\n',
      'utf8',
    );

    const guard = checkActiveRunGuard(lockPath, [id]);
    expect(guard.ok).toBe(false);
    expect(guard.runId).toBe(id);
    expect(guard.pid).toBe(process.pid);
    expect(guard.message).toContain(id);
    expect(guard.message).toContain(String(process.pid));

    expect(existsSync(runDir)).toBe(true);
  });

  it('cleanup_active_run_guard_on_central_lock: stale lock (dead pid) ignored → cleanup proceeds', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const repoKey = 'r-aaaaaaaaaaaa';
    const id = '20260522T180000-dead';
    const runDir = seedRun(storeRoot, repoKey, id, {
      workspace: { worktreePath: '/x', branch: 'b', createdByGan: false },
    });
    const lockPath = resolveRunLockPath(storeRoot, repoKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ runId: id, pid: DEAD_PID, startedAt: 'old', hostname: 'h' }) + '\n',
      'utf8',
    );

    const guard = checkActiveRunGuard(lockPath, [id]);
    expect(guard.ok).toBe(true);

    const run = findRun(resolveRunsRoot(storeRoot, repoKey), id)!;
    const plan = planRunCleanup(run, { fromDir: '/x', git: () => '' });
    const outcome = executeRunCleanup(plan, { fromDir: '/x', git: () => '', yes: true });
    expect(outcome.runDirRemoved).toBe(true);
    expect(existsSync(runDir)).toBe(false);
  });
});

describe('zone safety — slice-4 helpers never touch module-state / .claude/gan / .gan-cache', () => {
  it('recovery_cleanup_never_touch_module_or_config: module-state fixture byte-identical after full flow', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    const main = initRepo();
    const repoKey = resolveRepoKey(main);

    const moduleStateDir = path.join(main, '.gan-state', 'modules', 'dummy');
    mkdirSync(moduleStateDir, { recursive: true });
    const moduleStateFile = path.join(moduleStateDir, 'state.json');
    const moduleStatePayload = '{"ports":{"app":51234},"sentinel":"do-not-touch"}\n';
    writeFileSync(moduleStateFile, moduleStatePayload, 'utf8');

    const claudeGan = path.join(main, '.claude', 'gan', 'project.md');
    mkdirSync(path.dirname(claudeGan), { recursive: true });
    writeFileSync(claudeGan, '# overlay\n', 'utf8');
    const ganCache = path.join(main, '.gan-cache', 'cache.json');
    mkdirSync(path.dirname(ganCache), { recursive: true });
    writeFileSync(ganCache, '{"cached":true}\n', 'utf8');

    const userId = '20260522T180000-c0de';
    const userWt = path.join(makeTmp('cas-f7s4-userwt-'), 'mine');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/mine', userWt]);
    seedRun(storeRoot, repoKey, userId, {
      projectRoot: canonicalizePath(main),
      workspace: { worktreePath: canonicalizePath(userWt), branch: 'feature/mine', createdByGan: false },
    });

    const runsRoot = resolveRunsRoot(storeRoot, repoKey);

    const runs = enumerateRuns(runsRoot);
    for (const r of runs) {
      if (r.workspace?.worktreePath) {
        checkRecoveryAnchor({
          runId: r.runId,
          workspace: { worktreePath: r.workspace.worktreePath, branch: r.workspace.branch ?? '' },
          fromDir: main,
        });
      }
      const plan = planRunCleanup(r, { fromDir: main });
      executeRunCleanup(plan, { fromDir: main, yes: true, warn: () => {} });
    }

    expect(readFileSync(moduleStateFile, 'utf8')).toBe(moduleStatePayload);
    expect(readFileSync(claudeGan, 'utf8')).toBe('# overlay\n');
    expect(readFileSync(ganCache, 'utf8')).toBe('{"cached":true}\n');

    expect(existsSync(userWt)).toBe(true);
    expect(git(main, ['branch', '--list', 'feature/mine']).trim().length).toBeGreaterThan(0);
  });
});

describe('shell_and_subprocess_safety — hostile branch/path stay single argv elements', () => {
  it('a hostile branch name and worktree path are passed as single argv elements; no canary', () => {
    const cwd = process.cwd();
    const canary = path.join(makeTmp('cas-f7s4-canary-'), 'CANARY');
    const hostileBranch = `feature/x$(touch ${canary});\`id\``;
    const hostileWorktree = `/tmp/wt$(touch ${canary})`;

    const argv: string[][] = [];

    const fakeGit: GitExec = (args) => {
      argv.push([...args]);
      const joined = args.join(' ');
      if (joined.includes('--is-ancestor')) return '';
      if (joined.includes('@{upstream}')) throw new Error('no upstream');
      return '';
    };

    const run: EnumeratedRun = {
      runId: '20260522T180000-evil',
      runDir: makeTmp('cas-f7s4-evilrun-'),
      progressPath: '/x/progress.json',
      hasProgress: true,
      mtimeMs: 0,
      baseBranch: 'develop',
      workspace: { worktreePath: hostileWorktree, branch: hostileBranch, createdByGan: true },
    };

    const plan = planRunCleanup(run, { fromDir: cwd, git: fakeGit });
    expect(plan.branchPlan.kind).toBe('delete-merged');
    executeRunCleanup(plan, {
      fromDir: cwd,
      git: fakeGit,
      yes: true,
      rmDir: () => {},
      warn: () => {},
    });

    const del = argv.find((a) => a[0] === 'branch' && a[1] === '-D');
    expect(del).toEqual(['branch', '-D', hostileBranch]);
    const wtRemove = argv.find((a) => a[0] === 'worktree' && a[1] === 'remove');
    expect(wtRemove).toEqual(['worktree', 'remove', '--force', hostileWorktree]);

    expect(existsSync(canary)).toBe(false);
  });

  it('REAL git: a hostile branch name reaches git as one literal arg, no canary side-effect', () => {
    const repo = initRepo();

    const hostileBranch = 'feature/x;true>CANARY&true';
    const canary = path.join(repo, 'CANARY');
    git(repo, ['branch', hostileBranch, 'develop']);

    const argv: string[][] = [];
    const realGit: GitExec = (args, cwd) => {
      argv.push([...args]);
      return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    };

    expect(isBranchMerged(realGit, repo, hostileBranch, 'develop')).toBe(true);
    realGit(['branch', '-D', hostileBranch], repo);

    expect(existsSync(canary)).toBe(false);
    expect(git(repo, ['branch', '--list', hostileBranch]).trim()).toBe('');
  });
});

describe('static checks — argv-only subprocess + no committed secrets/home paths', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const sliceFiles = [
    'src/config-server/storage/run-lock.ts',
    'src/config-server/storage/recovery-anchor.ts',
    'src/config-server/storage/run-enumerator.ts',
    'src/config-server/storage/cleanup-planner.ts',
  ];
  const sources = sliceFiles.map((f) => readFileSync(path.join(repoRoot, f), 'utf8'));
  const combined = sources.join('\n');

  it('shell_and_subprocess_safety: no exec/execSync command-string API, no shell:true', () => {

    expect(/\bexecSync\b/.test(combined)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(combined)).toBe(false);
    expect(/[^F]\bexec\s*\(/.test(combined)).toBe(false);
    expect(/shell\s*:\s*true/.test(combined)).toBe(false);

    expect(/exec\w*\(\s*`/.test(combined)).toBe(false);
  });

  it('shell_and_subprocess_safety: no unconditional `git branch -D` outside the gated delete', () => {
    const cleanup = readFileSync(
      path.join(repoRoot, 'src/config-server/storage/cleanup-planner.ts'),
      'utf8',
    );

    const deleteHits = cleanup.match(/'branch', '-D'/g) ?? [];
    expect(deleteHits.length).toBe(1);

    expect(cleanup).toContain("'merge-base', '--is-ancestor'");
  });

  it('canonicalises paths through the determinism module (no ad-hoc realpath/lowercase/trim)', () => {
    const anchor = readFileSync(
      path.join(repoRoot, 'src/config-server/storage/recovery-anchor.ts'),
      'utf8',
    );
    expect(anchor).toContain("from '../determinism/index.js'");
    expect(anchor).toContain('canonicalizePath');
    expect(/realpathSync/.test(combined)).toBe(false);
    expect(/\.toLowerCase\s*\(/.test(combined)).toBe(false);

    expect(/slice\(\s*0\s*,\s*-1\s*\)/.test(combined)).toBe(false);
  });

  it('secrets_not_committed: no hardcoded credential/token or absolute home path literal', () => {
    for (const src of sources) {
      expect(/\/Users\/[A-Za-z0-9._-]+\//.test(src)).toBe(false);
      expect(/\/home\/[A-Za-z0-9._-]+\//.test(src)).toBe(false);
      expect(/(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9]{12,}/i.test(src)).toBe(
        false,
      );
    }
  });
});

describe('enumeration — absent runs root', () => {
  it('returns [] when <store-root>/<repo-key>/runs does not exist', () => {
    const storeRoot = makeTmp('cas-f7s4-store-');
    expect(enumerateRuns(resolveRunsRoot(storeRoot, 'r-aaaaaaaaaaaa'))).toEqual([]);
  });

  it('planRunCleanup handles a missing branch (no-branch) without a git call', () => {
    let called = false;
    const plan: RunCleanupPlan = planRunCleanup(
      {
        runId: 'r1',
        runDir: '/x',
        progressPath: '/x/progress.json',
        hasProgress: true,
        mtimeMs: 0,
        workspace: { worktreePath: '/wt', createdByGan: true },
      },
      {
        fromDir: '/x',
        git: () => {
          called = true;
          return '';
        },
      },
    );
    expect(plan.branchPlan).toEqual({ kind: 'none', reason: 'no-branch' });
    expect(called).toBe(false);
  });
});

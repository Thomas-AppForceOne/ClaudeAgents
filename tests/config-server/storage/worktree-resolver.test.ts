/**
 * F7 slice 2 — worktree-aware execution (cases 1a / 1b / 1c).
 *
 * Covers the sprint-2 contract criteria:
 *   - slug-derivation-deterministic
 *   - branch-terminal-component-match
 *   - resolver-1a-reuse-in-place
 *   - resolver-1b-clean-wrap
 *   - resolver-1b-dirty-refuses
 *   - resolver-1c-create
 *   - new-worktree-flag-forces-1c
 *   - progress-workspace-fields-persisted
 *   - default-branch-source-resolved
 *   - git-subprocess-argv-safety
 *
 * Unit tests use the injectable git exec seam (a scriptable fake that records
 * every argv it is handed); a separate integration suite exercises 1b/1c with
 * real `git worktree`. The static half of the security criterion greps the
 * slice's source files at the bottom of this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  canonicalizePath,
  canonicalizePathForDisplay,
} from '../../../src/config-server/determinism/index.js';
import {
  branchMatchesSlug,
  resolveDefaultBranch,
  resolveWorkspace,
  slugify,
  terminalSlug,
  type GitExec,
} from '../../../src/config-server/storage/worktree-resolver.js';
import {
  buildWorkspaceRecord,
  recordWorkspace,
} from '../../../src/config-server/storage/run-progress.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'cas-worktree-'): string {
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

// ---------------------------------------------------------------------------
// A scriptable fake git seam. Each test provides a map from a stable argv-key
// to a handler returning stdout (or throwing to mimic a non-zero exit). Every
// call's argv array is captured so tests can assert what git was asked to do.
// ---------------------------------------------------------------------------

interface FakeGit {
  git: GitExec;
  /** Every argv array, in call order. */
  calls: string[][];
}

function makeFakeGit(handlers: Record<string, (args: string[]) => string>): FakeGit {
  const calls: string[][] = [];
  const git: GitExec = (args, _cwd) => {
    const argv = [...args];
    calls.push(argv);
    const key = argv.join(' ');
    // Find the first handler whose key is a prefix of the joined argv, so a
    // handler keyed `worktree list --porcelain` matches that exact call.
    const handler = handlers[key] ?? prefixMatch(handlers, key);
    if (handler === undefined) {
      throw new Error(`fake git: no handler for argv: ${key}`);
    }
    return handler(argv);
  };
  return { git, calls };
}

function prefixMatch(
  handlers: Record<string, (args: string[]) => string>,
  key: string,
): ((args: string[]) => string) | undefined {
  for (const [k, h] of Object.entries(handlers)) {
    if (key === k || key.startsWith(k + ' ')) return h;
  }
  return undefined;
}

function throwExit(): never {
  throw new Error('git exited non-zero');
}

/** Argv keys that, if present in `calls`, indicate a mutation we forbid in 1b-dirty. */
function hasArgv(calls: string[][], predicate: (argv: string[]) => boolean): boolean {
  return calls.some(predicate);
}

// ---- slug derivation ------------------------------------------------------

describe('slugify — deterministic + case-insensitive', () => {
  it('slug-derivation-deterministic: same subject twice → byte-equal', () => {
    const a = slugify('My Spec Name');
    const b = slugify('My Spec Name');
    expect(a).toBe(b);
  });

  it('slug-derivation-deterministic: subjects differing only by case → equal', () => {
    expect(slugify('Add Export')).toBe(slugify('ADD EXPORT'));
    expect(slugify('add export')).toBe(slugify('Add Export'));
  });

  it('slug-derivation-deterministic: known prompt → exact expected slug', () => {
    expect(slugify('Add Export!')).toBe('add-export');
    expect(slugify('  Add   Export  ')).toBe('add-export');
    expect(slugify('feature/add-export')).toBe('feature-add-export');
    // Underscores are preserved (hyphen-or-underscore-safe).
    expect(slugify('add_export feature')).toBe('add_export-feature');
  });

  it('collapses shell metacharacters into hyphens (defence in depth)', () => {
    expect(slugify('add; rm -rf .')).toBe('add-rm-rf');
    expect(slugify('$(whoami)')).toBe('whoami');
    expect(slugify('`id`')).toBe('id');
  });
});

describe('branchMatchesSlug — terminal-component match', () => {
  it('branch-terminal-component-match: matches against the slugified terminal component', () => {
    expect(branchMatchesSlug('feature/add-export', 'add-export')).toBe(true);
    expect(branchMatchesSlug('FEATURE/ADD-EXPORT', 'add-export')).toBe(true); // case-insensitive
    expect(branchMatchesSlug('add-export', 'add-export')).toBe(true); // bare, no slash
    expect(branchMatchesSlug('feature/add-export-2', 'add-export')).toBe(false);
    expect(branchMatchesSlug('feature/other', 'add-export')).toBe(false);
  });

  it('terminalSlug picks the last path component', () => {
    expect(terminalSlug('feature/add-export')).toBe('add-export');
    expect(terminalSlug('a/b/c/Final-Thing')).toBe('final-thing');
    expect(terminalSlug('bare')).toBe('bare');
  });
});

// ---- 1a: reuse in place ---------------------------------------------------

describe('resolver — case 1a (reuse in place)', () => {
  it('resolver-1a-reuse-in-place: matching branch + dedicated cwd → no new worktree, createdByGan false', () => {
    const cwd = '/repos/myapp-add-export';
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => `${cwd}\n`,
      // git-common-dir parent = /repos/myapp (the main checkout) — the cwd is a
      // distinct *linked* worktree dedicated to the task branch → 1a.
      'rev-parse --git-common-dir': () => '/repos/myapp/.git\n',
      'worktree list --porcelain': () =>
        [
          'worktree /repos/myapp',
          'HEAD 1111111111111111111111111111111111111111',
          'branch refs/heads/develop',
          '',
          `worktree ${cwd}`,
          'HEAD 2222222222222222222222222222222222222222',
          'branch refs/heads/feature/add-export',
          '',
        ].join('\n'),
    });

    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: cwd,
      git: fake.git,
    });

    expect(ws.resolutionCase).toBe('1a');
    expect(ws.createdByGan).toBe(false);
    expect(ws.branch).toBe('feature/add-export');
    // The resolved worktree is the current worktree (display/realpath form —
    // a usable, case-preserving recovery anchor; the persisted progress.json
    // field is the case-folded canonical form, asserted in recordWorkspace).
    expect(ws.worktreePath).toBe(canonicalizePathForDisplay(cwd));
    // No `git worktree add` was issued.
    expect(hasArgv(fake.calls, (a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });
});

// ---- 1b: clean wrap -------------------------------------------------------

describe('resolver — case 1b (clean wrap)', () => {
  function clean1bGit(defaultBranchOccupied = false): FakeGit {
    // Branch matches; cwd is the main checkout (NOT dedicated to the branch).
    const main = '/repos/myapp';
    const otherWtForDevelop = '/repos/myapp-develop';
    const worktreeList = [
      `worktree ${main}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/add-export',
      '',
    ];
    if (defaultBranchOccupied) {
      worktreeList.push(
        `worktree ${otherWtForDevelop}`,
        'HEAD 3333333333333333333333333333333333333333',
        'branch refs/heads/develop',
        '',
      );
    }
    return makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => `${main}\n`,
      // git-common-dir parent = main checkout → cwd IS the main checkout → 1b.
      'rev-parse --git-common-dir': () => `${main}/.git\n`,
      'worktree list --porcelain': () => worktreeList.join('\n'),
      'status --porcelain': () => '', // clean
      // default-branch resolution: no origin/HEAD, no init.defaultBranch local
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': () => throwExit(),
      'config --get init.defaultBranch': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/develop': () => 'ok\n', // develop exists
      'rev-parse --verify --quiet refs/heads/main': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/master': () => throwExit(),
      checkout: () => '',
      'worktree add': () => '',
    });
  }

  it('resolver-1b-clean-wrap: switches to default branch, worktree-adds task branch, createdByGan true', () => {
    const fake = clean1bGit(false);
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      git: fake.git,
    });

    expect(ws.resolutionCase).toBe('1b');
    expect(ws.createdByGan).toBe(true);
    expect(ws.branch).toBe('feature/add-export');

    const runScoped = path.join(
      '/repos/myapp',
      '.gan-state',
      'runs',
      '20260522T180000-9c4f',
      'worktree',
    );
    expect(ws.worktreePath).toBe(canonicalizePathForDisplay(runScoped));

    // (1) the current checkout was switched to the default branch `develop`.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === 'develop')).toBe(true);

    // (2) a `git worktree add` (no -b, the branch already exists) placed the
    //     task branch under the run-scoped path.
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toBeDefined();
    expect(add).toContain('feature/add-export');
    expect(add).toContain(runScoped);

    // (no --force anywhere)
    expect(hasArgv(fake.calls, (a) => a.includes('--force'))).toBe(false);
  });

  it('default-branch-source-resolved: detaches HEAD as fallback when default branch is occupied', () => {
    const fake = clean1bGit(true); // develop is checked out in another worktree
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      git: fake.git,
    });
    expect(ws.resolutionCase).toBe('1b');
    // Fallback: HEAD detached rather than checking out the occupied default.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === '--detach')).toBe(true);
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === 'develop')).toBe(false);
  });
});

// ---- 1b: dirty refuses ----------------------------------------------------

describe('resolver — case 1b dirty (refuses)', () => {
  it('resolver-1b-dirty-refuses: throws, issues no mutation, names commit/stash/dedicated-worktree', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => '/repos/myapp\n',
      'rev-parse --git-common-dir': () => '/repos/myapp/.git\n', // cwd is main checkout
      'worktree list --porcelain': () =>
        [
          'worktree /repos/myapp',
          'HEAD 2222222222222222222222222222222222222222',
          'branch refs/heads/feature/add-export',
          '',
        ].join('\n'),
      'status --porcelain': () => ' M dirty.txt\n?? new.txt\n', // DIRTY
    });

    let threw: unknown;
    try {
      resolveWorkspace({
        subject: 'Add Export',
        runId: '20260522T180000-9c4f',
        projectRoot: '/repos/myapp',
        fromDir: '/repos/myapp',
        git: fake.git,
      });
    } catch (e) {
      threw = e;
    }

    // (1) the resolver refused.
    expect(threw).toBeInstanceOf(Error);
    const message = (threw as Error).message;

    // (3) the message names committing / stashing / dedicated worktree.
    expect(message.toLowerCase()).toMatch(/commit/);
    expect(message.toLowerCase()).toMatch(/stash/);
    expect(message.toLowerCase()).toMatch(/worktree/);

    // F4 prose-discipline: shell remediation, no Node/npm tokens.
    expect(/(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/.test(message)).toBe(false);

    // (2) no branch switch / detach / stash / worktree-add was issued after
    //     dirtiness was detected.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout')).toBe(false);
    expect(hasArgv(fake.calls, (a) => a[0] === 'stash')).toBe(false);
    expect(hasArgv(fake.calls, (a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });
});

// ---- 1c: create -----------------------------------------------------------

describe('resolver — case 1c (create)', () => {
  function nonMatchingGit(): FakeGit {
    return makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'develop\n', // does NOT match slug
      'rev-parse --show-toplevel': () => '/repos/myapp\n',
      'worktree list --porcelain': () =>
        [
          'worktree /repos/myapp',
          'HEAD 2222222222222222222222222222222222222222',
          'branch refs/heads/develop',
          '',
        ].join('\n'),
      'worktree add': () => '',
    });
  }

  it('resolver-1c-create: non-matching branch → new task branch + run-scoped worktree, createdByGan true', () => {
    const fake = nonMatchingGit();
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      git: fake.git,
    });

    expect(ws.resolutionCase).toBe('1c');
    expect(ws.createdByGan).toBe(true);
    expect(ws.branch).toBe('feature/add-export');

    const runScoped = path.join(
      '/repos/myapp',
      '.gan-state',
      'runs',
      '20260522T180000-9c4f',
      'worktree',
    );
    expect(ws.worktreePath).toBe(canonicalizePathForDisplay(runScoped));

    // `git worktree add -b feature/add-export <run-scoped>`.
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual(['worktree', 'add', '-b', 'feature/add-export', runScoped]);
    expect(add).not.toContain('--force');
  });
});

// ---- --new-worktree forces 1c ---------------------------------------------

describe('resolver — --new-worktree forces 1c', () => {
  it('new-worktree-flag-forces-1c: forces 1c in a context that would match 1a', () => {
    const cwd = '/repos/myapp-add-export';
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => `${cwd}\n`,
      'worktree list --porcelain': () =>
        [`worktree ${cwd}`, 'branch refs/heads/feature/add-export', ''].join('\n'),
      'worktree add': () => '',
    });

    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: cwd,
      newWorktree: true,
      git: fake.git,
    });

    expect(ws.resolutionCase).toBe('1c');
    expect(ws.createdByGan).toBe(true);
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add?.[2]).toBe('-b');
    expect(add?.[3]).toBe('feature/add-export');
  });

  it('new-worktree-flag-forces-1c: forces 1c in a context that would match 1b', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => '/repos/myapp\n',
      'worktree list --porcelain': () =>
        ['worktree /repos/myapp', 'branch refs/heads/feature/add-export', ''].join('\n'),
      'status --porcelain': () => '',
      'worktree add': () => '',
    });

    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      newWorktree: true,
      git: fake.git,
    });

    expect(ws.resolutionCase).toBe('1c');
    expect(ws.createdByGan).toBe(true);
    // 1c does not free a branch — no checkout/detach issued.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout')).toBe(false);
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('-b');
  });
});

// ---- default-branch resolution (unit) -------------------------------------

describe('resolveDefaultBranch — not hardcoded', () => {
  it('default-branch-source-resolved: prefers origin/HEAD when present', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': () => 'origin/trunk\n',
      'rev-parse --verify --quiet refs/heads/trunk': () => 'ok\n',
    });
    expect(resolveDefaultBranch(fake.git, '/repos/myapp')).toBe('trunk');
  });

  it('default-branch-source-resolved: uses init.defaultBranch when origin/HEAD absent', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': () => throwExit(),
      'config --get init.defaultBranch': () => 'mainline\n',
      'rev-parse --verify --quiet refs/heads/mainline': () => 'ok\n',
    });
    expect(resolveDefaultBranch(fake.git, '/repos/myapp')).toBe('mainline');
  });

  it('default-branch-source-resolved: falls back to develop > main > master', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': () => throwExit(),
      'config --get init.defaultBranch': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/develop': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/main': () => 'ok\n',
      'rev-parse --verify --quiet refs/heads/master': () => throwExit(),
    });
    expect(resolveDefaultBranch(fake.git, '/repos/myapp')).toBe('main');
  });

  it('returns undefined when no candidate branch is present (caller detaches)', () => {
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': () => throwExit(),
      'config --get init.defaultBranch': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/develop': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/main': () => throwExit(),
      'rev-parse --verify --quiet refs/heads/master': () => throwExit(),
    });
    expect(resolveDefaultBranch(fake.git, '/repos/myapp')).toBeUndefined();
  });
});

// ---- progress.json workspace persistence ----------------------------------

describe('recordWorkspace — workspace fields in progress.json', () => {
  it('progress-workspace-fields-persisted: writes all three fields, canonical worktreePath', () => {
    const runDir = makeTmp('cas-progress-');
    const progressPath = path.join(runDir, 'progress.json');
    const worktreePath = makeTmp('cas-wt-canon-'); // exists on disk → realpath works

    // 1a → createdByGan false.
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/add-export',
      createdByGan: false,
      resolutionCase: '1a',
    });
    let json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.workspace).toBeDefined();
    expect(json.workspace.worktreePath).toBe(canonicalizePath(worktreePath));
    expect(path.isAbsolute(json.workspace.worktreePath)).toBe(true);
    expect(json.workspace.branch).toBe('feature/add-export');
    expect(json.workspace.createdByGan).toBe(false);

    // 1b → createdByGan true (overwrites prior, preserving other keys).
    writeFileSync(progressPath, JSON.stringify({ runId: 'keep-me', workspace: 'old' }), 'utf8');
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/add-export',
      createdByGan: true,
      resolutionCase: '1b',
    });
    json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.runId).toBe('keep-me'); // pre-existing field preserved
    expect(json.workspace.createdByGan).toBe(true);

    // 1c → createdByGan true.
    const r = buildWorkspaceRecord({
      worktreePath,
      branch: 'feature/other',
      createdByGan: true,
      resolutionCase: '1c',
    });
    expect(r.createdByGan).toBe(true);
    expect(r.branch).toBe('feature/other');
    expect(r.worktreePath).toBe(canonicalizePath(worktreePath));
  });

  it('ignores prototype-polluting keys in a pre-existing progress.json', () => {
    const runDir = makeTmp('cas-progress-pp-');
    const progressPath = path.join(runDir, 'progress.json');
    const worktreePath = makeTmp('cas-wt-pp-');
    writeFileSync(progressPath, '{"__proto__":{"polluted":true},"keep":1}', 'utf8');
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/x',
      createdByGan: true,
      resolutionCase: '1c',
    });
    const obj: Record<string, unknown> = {};
    expect((obj as Record<string, unknown>)['polluted']).toBeUndefined();
    const json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.keep).toBe(1);
  });
});

// ---- security: argv safety with a hostile subject -------------------------

describe('git-subprocess-argv-safety (behavioural)', () => {
  it('a subject with shell metacharacters reaches git as a single literal argv element', () => {
    // A crafted subject containing `;`, `$(...)`, and backticks. Through slug
    // derivation it becomes a clean token, but the test asserts the branch
    // name is passed to git as ONE argv element with no shell expansion.
    const hostile = 'pwn; rm -rf .; $(touch /tmp/EVIL); `id`';
    const slug = slugify(hostile);
    // Derivation strips the metacharacters entirely.
    expect(slug).not.toContain(';');
    expect(slug).not.toContain('$');
    expect(slug).not.toContain('`');
    expect(slug).not.toContain(' ');

    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'develop\n',
      'rev-parse --show-toplevel': () => '/repos/myapp\n',
      'worktree list --porcelain': () =>
        ['worktree /repos/myapp', 'branch refs/heads/develop', ''].join('\n'),
      'worktree add': () => '',
    });

    resolveWorkspace({
      subject: hostile,
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      git: fake.git,
    });

    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toBeDefined();
    // The branch name is one argv element (`-b` then the branch); the slug
    // contains no metacharacter, and even if it did it is a single element.
    const branchArg = add![add!.indexOf('-b') + 1];
    expect(branchArg).toBe(`feature/${slug}`);
    // No EVIL side effect could have run — the seam never builds a shell string.
    expect(existsSync('/tmp/EVIL')).toBe(false);
  });
});

// ---- integration: real git worktree ---------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function initRepo(): string {
  const repo = makeTmp('cas-int-repo-');
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function currentBranchOf(cwd: string): string {
  try {
    return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    return ''; // detached
  }
}

describe('integration — real git worktree (1c then 1b)', () => {
  it('resolver-1c-create (real git): creates branch + run-scoped worktree, leaves origin checkout alone', () => {
    const repo = initRepo();
    const runId = '20260522T180000-1c1c';

    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId,
      projectRoot: repo,
      fromDir: repo,
    });

    expect(ws.resolutionCase).toBe('1c');
    expect(ws.createdByGan).toBe(true);
    expect(ws.branch).toBe('feature/add-export');

    const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
    expect(existsSync(runScoped)).toBe(true);
    // The run worktree is checked out to the task branch.
    expect(currentBranchOf(runScoped)).toBe('feature/add-export');
    // The original checkout is untouched (still on develop).
    expect(currentBranchOf(repo)).toBe('develop');
  });

  it('resolver-1b-clean-wrap (real git): frees the matching branch onto develop, wraps it', () => {
    const repo = initRepo();
    // Put the matching task branch in the MAIN checkout (non-dedicated for it).
    git(repo, ['checkout', '-q', '-b', 'feature/add-export']);
    expect(currentBranchOf(repo)).toBe('feature/add-export');

    const runId = '20260522T180000-1b1b';
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId,
      projectRoot: repo,
      fromDir: repo,
    });

    expect(ws.resolutionCase).toBe('1b');
    expect(ws.createdByGan).toBe(true);
    expect(ws.branch).toBe('feature/add-export');

    const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
    expect(existsSync(runScoped)).toBe(true);
    // The task branch ends up in the run-scoped worktree…
    expect(currentBranchOf(runScoped)).toBe('feature/add-export');
    // …and the original checkout was freed to the default branch `develop`.
    expect(currentBranchOf(repo)).toBe('develop');
  });

  it('resolver-1b-clean-wrap (real git): detaches when develop is occupied elsewhere', () => {
    const repo = initRepo();
    // Move the main checkout onto the task branch first (freeing `develop`),
    // then occupy `develop` in a separate worktree so the resolver's fallback
    // path — detach instead of checkout develop — must fire.
    git(repo, ['checkout', '-q', '-b', 'feature/add-export']);
    const developWt = path.join(makeTmp('cas-int-dev-'), 'dev');
    git(repo, ['worktree', 'add', '-q', developWt, 'develop']);

    const runId = '20260522T180000-1bdt';
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId,
      projectRoot: repo,
      fromDir: repo,
    });

    expect(ws.resolutionCase).toBe('1b');
    const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
    expect(currentBranchOf(runScoped)).toBe('feature/add-export');
    // The origin checkout is now detached (develop was occupied).
    expect(currentBranchOf(repo)).toBe('');
  });
});

// ---- static security check: git-subprocess-argv-safety --------------------

describe('git-subprocess-argv-safety (static source check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const sources = ['worktree-resolver.ts', 'run-progress.ts'].map((f) =>
    readFileSync(path.join(repoRoot, 'src', 'config-server', 'storage', f), 'utf8'),
  );
  const combined = sources.join('\n');

  it('uses execFileSync (argv array), never exec/execSync/shell:true', () => {
    expect(combined).toContain('execFileSync');
    // No bare `exec`/`execSync` command-string APIs imported or called.
    expect(/\bexec\b\s*,/.test(combined)).toBe(false);
    expect(/\bexecSync\b/.test(combined)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(combined)).toBe(false);
    expect(/shell\s*:\s*true/.test(combined)).toBe(false);
    // No template-literal command string is fed to a subprocess API.
    expect(/exec\w*\(\s*`/.test(combined)).toBe(false);
  });

  it('passes git argv as arrays and never uses worktree add --force', () => {
    // The default seam invokes `execFileSync('git', [...args], ...)`.
    expect(/execFileSync\(\s*['"]git['"]\s*,\s*\[/.test(combined)).toBe(true);
    // No `--force` token appears anywhere in the slice's source.
    expect(combined.includes('--force')).toBe(false);
  });

  it('canonicalises the recorded path through the determinism module, not a re-implementation', () => {
    // The recorded `worktreePath` goes through the centralised determinism
    // module; this slice never re-implements realpath / path case-folding.
    // (`slugify` lowercases the run *subject*, not a path — that is the only
    // `.toLowerCase()` and it lives in worktree-resolver.ts, asserted below.)
    const progressSrc = readFileSync(
      path.join(repoRoot, 'src', 'config-server', 'storage', 'run-progress.ts'),
      'utf8',
    );
    expect(progressSrc).toContain("from '../determinism/index.js'");
    expect(progressSrc).toContain('canonicalizePath');
    // No path-canonicalisation re-implementation in either source file.
    expect(/realpathSync/.test(combined)).toBe(false);
    // The only `.toLowerCase()` is on the subject inside slugify (not a path).
    expect(/\.toLowerCase\s*\(/.test(progressSrc)).toBe(false);
  });
});

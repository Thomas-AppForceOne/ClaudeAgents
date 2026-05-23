// Covers workspace resolution — how a /gan run picks (or creates) the git
// worktree it will work in for a given subject. The resolution cases:
//   1a (reuse in place): the current checkout already sits on the matching task
//      branch in a dedicated dir → reuse it, createdByGan false, no new
//      worktree;
//   1b (clean wrap): the matching branch is checked out in the MAIN checkout
//      and the tree is clean → free it by switching main to the default branch
//      (or detaching when that branch is occupied elsewhere) and wrap the task
//      branch in a run-scoped worktree;
//   1c (create): no matching branch → create a fresh task branch + run-scoped
//      worktree;
//   plus the dirty-tree refusal (1b with uncommitted changes throws, mutates
//   nothing, and the message guides the user toward commit/stash/worktree
//   without leaking implementation names), and --new-worktree forcing 1c.
// Also pins slug derivation (deterministic, case-insensitive, shell-meta
// stripped), branch terminal-component matching, default-branch resolution
// order (origin/HEAD > init.defaultBranch > develop > main > master), and that
// the recorded workspace path is canonical and prototype-pollution-safe.
// The behavioural + static-source safety cases pin that hostile subjects reach
// git as single literal argv elements and that no `worktree add --force` or
// shell-string exec is ever used.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
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

interface FakeGit {
  git: GitExec;

  calls: string[][];
}

// Builds a fake GitExec that dispatches on the joined argv string. Handlers are
// keyed by the exact argv (e.g. 'status --porcelain'); an unmatched argv is a
// hard error so a test can never silently exercise an unstubbed git call. Every
// invocation is recorded in `calls` for argv-level assertions.
function makeFakeGit(handlers: Record<string, (args: string[]) => string>): FakeGit {
  const calls: string[][] = [];
  const git: GitExec = (args, _cwd) => {
    const argv = [...args];
    calls.push(argv);
    const key = argv.join(' ');

    const handler = handlers[key] ?? prefixMatch(handlers, key);
    if (handler === undefined) {
      throw new Error(`fake git: no handler for argv: ${key}`);
    }
    return handler(argv);
  };
  return { git, calls };
}

// Falls back from exact-match to longest-prefix match so a handler keyed on
// e.g. 'worktree add' answers any 'worktree add <args...>' invocation.
function prefixMatch(
  handlers: Record<string, (args: string[]) => string>,
  key: string,
): ((args: string[]) => string) | undefined {
  for (const [k, h] of Object.entries(handlers)) {
    if (key === k || key.startsWith(k + ' ')) return h;
  }
  return undefined;
}

// Simulates a non-zero git exit (the way the real seam signals "ref/branch
// absent"), used by handlers that should report a candidate as missing.
function throwExit(): never {
  throw new Error('git exited non-zero');
}

// True if any recorded git invocation matches the predicate.
function hasArgv(calls: string[][], predicate: (argv: string[]) => boolean): boolean {
  return calls.some(predicate);
}

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

    expect(slugify('add_export feature')).toBe('add_export-feature');
  });

  it('collapses shell metacharacters into hyphens (defence in depth)', () => {
    // Even before argv-level safety, the slug itself strips shell syntax, so a
    // derived branch name can never carry an injection payload.
    expect(slugify('add; rm -rf .')).toBe('add-rm-rf');
    expect(slugify('$(whoami)')).toBe('whoami');
    expect(slugify('`id`')).toBe('id');
  });
});

describe('branchMatchesSlug — terminal-component match', () => {
  it('branch-terminal-component-match: matches against the slugified terminal component', () => {
    expect(branchMatchesSlug('feature/add-export', 'add-export')).toBe(true);
    expect(branchMatchesSlug('FEATURE/ADD-EXPORT', 'add-export')).toBe(true);
    expect(branchMatchesSlug('add-export', 'add-export')).toBe(true);
    expect(branchMatchesSlug('feature/add-export-2', 'add-export')).toBe(false);
    expect(branchMatchesSlug('feature/other', 'add-export')).toBe(false);
  });

  it('terminalSlug picks the last path component', () => {
    expect(terminalSlug('feature/add-export')).toBe('add-export');
    expect(terminalSlug('a/b/c/Final-Thing')).toBe('final-thing');
    expect(terminalSlug('bare')).toBe('bare');
  });
});

describe('resolver — case 1a (reuse in place)', () => {
  it('resolver-1a-reuse-in-place: matching branch + dedicated cwd → no new worktree, createdByGan false', () => {
    // cwd is a dedicated worktree (its own dir, distinct from the main checkout
    // at /repos/myapp) already on the matching branch, so resolution reuses it.
    const cwd = '/repos/myapp-add-export';
    const fake = makeFakeGit({
      'symbolic-ref --quiet --short HEAD': () => 'feature/add-export\n',
      'rev-parse --show-toplevel': () => `${cwd}\n`,

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

    expect(ws.worktreePath).toBe(canonicalizePathForDisplay(cwd));

    // The defining assertion for 1a: no new worktree was created.
    expect(hasArgv(fake.calls, (a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });
});

describe('resolver — case 1b (clean wrap)', () => {
  // Stubs the 1b scenario: the matching branch is checked out in the MAIN
  // checkout with a clean tree. `defaultBranchOccupied` adds a second worktree
  // already holding `develop`, which forces the detach fallback below. The
  // default-branch probes resolve to develop only (origin/HEAD and
  // init.defaultBranch are absent), so develop is the chosen base.
  function clean1bGit(defaultBranchOccupied = false): FakeGit {

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

      'rev-parse --git-common-dir': () => `${main}/.git\n`,
      'worktree list --porcelain': () => worktreeList.join('\n'),
      'status --porcelain': () => '', // clean

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

    // Main checkout is freed onto develop, then the task branch is wrapped in
    // the run-scoped worktree — and never with --force.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === 'develop')).toBe(true);

    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toBeDefined();
    expect(add).toContain('feature/add-export');
    expect(add).toContain(runScoped);

    expect(hasArgv(fake.calls, (a) => a.includes('--force'))).toBe(false);
  });

  it('default-branch-source-resolved: detaches HEAD as fallback when default branch is occupied', () => {
    // develop is held by another worktree, so main cannot check it out; the
    // resolver detaches HEAD instead of switching to develop.
    const fake = clean1bGit(true);
    const ws = resolveWorkspace({
      subject: 'Add Export',
      runId: '20260522T180000-9c4f',
      projectRoot: '/repos/myapp',
      fromDir: '/repos/myapp',
      git: fake.git,
    });
    expect(ws.resolutionCase).toBe('1b');

    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === '--detach')).toBe(true);
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout' && a[1] === 'develop')).toBe(false);
  });
});

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

    expect(threw).toBeInstanceOf(Error);
    const message = (threw as Error).message;

    // The refusal guidance must name the three remedies the user can take.
    expect(message.toLowerCase()).toMatch(/commit/);
    expect(message.toLowerCase()).toMatch(/stash/);
    expect(message.toLowerCase()).toMatch(/worktree/);

    // …but must not leak internal implementation/runtime names (npm/node/MCP)
    // unless they are quoted in backticks — this is a user-facing message.
    expect(/(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/.test(message)).toBe(false);

    // Refuse means refuse: no checkout, stash, or worktree-add side effects.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout')).toBe(false);
    expect(hasArgv(fake.calls, (a) => a[0] === 'stash')).toBe(false);
    expect(hasArgv(fake.calls, (a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });
});

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

    // 1c creates the branch in one step via `worktree add -b <branch> <path>`,
    // never with --force.
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual(['worktree', 'add', '-b', 'feature/add-export', runScoped]);
    expect(add).not.toContain('--force');
  });
});

describe('resolver — --new-worktree forces 1c', () => {
  it('new-worktree-flag-forces-1c: forces 1c in a context that would match 1a', () => {
    // This setup (dedicated dir already on the matching branch) would normally
    // resolve as 1a; --new-worktree overrides that and creates a fresh one.
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

    // Forcing 1c skips the 1b "free the branch" dance entirely — no checkout.
    expect(hasArgv(fake.calls, (a) => a[0] === 'checkout')).toBe(false);
    const add = fake.calls.find((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('-b');
  });
});

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
    // No origin/HEAD, no init.defaultBranch, and develop is absent, so the
    // ordered fallback lands on main (master is never probed once main hits).
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

describe('recordWorkspace — workspace fields in progress.json', () => {
  it('progress-workspace-fields-persisted: writes all three fields, canonical worktreePath', () => {
    const runDir = makeTmp('cas-progress-');
    const progressPath = path.join(runDir, 'progress.json');
    const worktreePath = makeTmp('cas-wt-canon-');

    // First write into a non-existent progress.json: the workspace record is
    // created with a canonical, absolute worktreePath and the three fields.
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/add-export',
      createdByGan: false,
      resolutionCase: '1a',
    });
    let json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.workspace).toBeDefined();
    expect(json.workspace.worktreePath).toBe(canonicalizePathForDisplay(worktreePath));
    expect(path.isAbsolute(json.workspace.worktreePath)).toBe(true);
    expect(json.workspace.branch).toBe('feature/add-export');
    expect(json.workspace.createdByGan).toBe(false);

    // Second write merges into an existing progress.json: the unrelated runId
    // is preserved while the workspace block is overwritten in place.
    writeFileSync(progressPath, JSON.stringify({ runId: 'keep-me', workspace: 'old' }), 'utf8');
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/add-export',
      createdByGan: true,
      resolutionCase: '1b',
    });
    json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.runId).toBe('keep-me');
    expect(json.workspace.createdByGan).toBe(true);

    const r = buildWorkspaceRecord({
      worktreePath,
      branch: 'feature/other',
      createdByGan: true,
      resolutionCase: '1c',
    });
    expect(r.createdByGan).toBe(true);
    expect(r.branch).toBe('feature/other');
    expect(r.worktreePath).toBe(canonicalizePathForDisplay(worktreePath));
  });

  it('ignores prototype-polluting keys in a pre-existing progress.json', () => {
    const runDir = makeTmp('cas-progress-pp-');
    const progressPath = path.join(runDir, 'progress.json');
    const worktreePath = makeTmp('cas-wt-pp-');
    // The pre-existing file carries a __proto__ payload; recordWorkspace must
    // not let it pollute Object.prototype while merging.
    writeFileSync(progressPath, '{"__proto__":{"polluted":true},"keep":1}', 'utf8');
    recordWorkspace(progressPath, {
      worktreePath,
      branch: 'feature/x',
      createdByGan: true,
      resolutionCase: '1c',
    });
    // A brand-new plain object has no `polluted` inherited property, proving the
    // prototype was not contaminated. The benign `keep` field still survives.
    const obj: Record<string, unknown> = {};
    expect((obj as Record<string, unknown>)['polluted']).toBeUndefined();
    const json = JSON.parse(readFileSync(progressPath, 'utf8'));
    expect(json.keep).toBe(1);
  });
});

describe('git-subprocess-argv-safety (behavioural)', () => {
  it('a subject with shell metacharacters reaches git as a single literal argv element', () => {
    // A subject loaded with injection payloads: slugify must strip every shell
    // metacharacter, and the resulting branch must reach git as one argv slot.
    const hostile = 'pwn; rm -rf .; $(touch /tmp/EVIL); `id`';
    const slug = slugify(hostile);

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

    const branchArg = add![add!.indexOf('-b') + 1];
    expect(branchArg).toBe(`feature/${slug}`);

    // The injection payload never executed: the EVIL marker file is absent.
    expect(existsSync('/tmp/EVIL')).toBe(false);
  });
});

// Argv-array git runner for the real-git integration cases below.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// Real repo with `develop` as the base branch (matching this project's flow).
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

// Returns the checked-out branch name of a worktree, or '' when HEAD is
// detached (symbolic-ref fails) — used to assert which branch each worktree
// ends up on after resolution.
function currentBranchOf(cwd: string): string {
  try {
    return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    return '';
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

    // The new branch lives in the run-scoped worktree; the origin checkout is
    // left untouched on develop.
    expect(currentBranchOf(runScoped)).toBe('feature/add-export');

    expect(currentBranchOf(repo)).toBe('develop');
  });

  it('resolver-1b-clean-wrap (real git): frees the matching branch onto develop, wraps it', () => {
    const repo = initRepo();

    // Put the main checkout on the matching branch (clean tree) so resolution
    // must free it onto develop before wrapping — the 1b path.
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

    expect(currentBranchOf(runScoped)).toBe('feature/add-export');

    expect(currentBranchOf(repo)).toBe('develop');
  });

  it('resolver-1b-clean-wrap (real git): detaches when develop is occupied elsewhere', () => {
    const repo = initRepo();

    // Main is on the matching branch AND develop is checked out in another
    // worktree, so the resolver cannot move main to develop and must detach
    // HEAD instead (asserted as '' for the origin checkout below).
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

    expect(currentBranchOf(repo)).toBe('');
  });
});

// Source-text greps over the resolver + its helpers. They pin discipline a
// behaviour test cannot see: every git call is execFileSync with an argv array
// (no exec/execSync command strings, no `shell:true`), `worktree add --force`
// is never used (it could clobber a user's tree), and canonicalisation is
// delegated to the determinism module rather than re-implemented.
describe('git-subprocess-argv-safety (static source check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const sources = ['worktree-resolver.ts', 'run-progress.ts', 'git-exec.ts'].map((f) =>
    readFileSync(path.join(repoRoot, 'src', 'config-server', 'storage', f), 'utf8'),
  );
  const combined = sources.join('\n');

  it('uses execFileSync (argv array), never exec/execSync/shell:true', () => {
    expect(combined).toContain('execFileSync');

    expect(/\bexec\b\s*,/.test(combined)).toBe(false);
    expect(/\bexecSync\b/.test(combined)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(combined)).toBe(false);
    expect(/shell\s*:\s*true/.test(combined)).toBe(false);

    expect(/exec\w*\(\s*`/.test(combined)).toBe(false);
  });

  it('passes git argv as arrays and never uses worktree add --force', () => {

    expect(/execFileSync\(\s*['"]git['"]\s*,\s*\[/.test(combined)).toBe(true);

    expect(combined.includes('--force')).toBe(false);
  });

  it('canonicalises the recorded path through the determinism module, not a re-implementation', () => {

    const progressSrc = readFileSync(
      path.join(repoRoot, 'src', 'config-server', 'storage', 'run-progress.ts'),
      'utf8',
    );
    expect(progressSrc).toContain("from '../determinism/index.js'");
    expect(progressSrc).toContain('canonicalizePath');

    expect(/realpathSync/.test(combined)).toBe(false);

    expect(/\.toLowerCase\s*\(/.test(progressSrc)).toBe(false);
  });
});

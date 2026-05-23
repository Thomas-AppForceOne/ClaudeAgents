// Covers the module-state store's path resolution. Module state lives in a
// central store keyed by repo, NOT inside the working tree, so it survives
// worktree removal and is shared across every worktree of the same repo.
//
// Pinned behaviours:
//   - store-root precedence: GAN_MODULE_STATE env > marker file > default
//     (~/.gan-module-state), with env/marker absolutised (~ expanded, relative
//     resolved against home, trailing whitespace trimmed);
//   - the module-state root is a distinct sibling of the run-data root (a
//     regression that aliased them would let one subsystem clobber the other);
//   - path shape <store>/<repo-key>/<module>/<key>.json, where the repo-key is
//     the F7 <basename>-<sha256[:12]> derivation reused from run-store (NOT
//     re-implemented here) and is canonical (slash/case-insensitive on
//     darwin/win32);
//   - the repo-key is shared across linked worktrees and memoised per fromDir,
//     while an injected git seam bypasses the memo.
// The static-source checks assert the implementation reuses the shared
// F7/store-common helpers and only ever shells out via argv arrays.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import {
  DEFAULT_STORE_DIRNAME,
  STORE_ROOT_ENV,
} from '../../../src/config-server/storage/run-store.js';
import {
  DEFAULT_MODULE_STATE_DIRNAME,
  MODULE_STATE_MARKER_RELPATH,
  MODULE_STATE_ROOT_ENV,
  _resetModuleRepoKeyCacheForTests,
  computeRepoKey,
  resolveModuleRepoKey,
  resolveModuleStatePath,
  resolveModuleStateRoot,
  resolveModuleStateStore,
} from '../../../src/config-server/storage/module-state-store.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'cas-module-state-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
});

beforeEach(() => {
  _resetModuleRepoKeyCacheForTests();
});

// Builds an injected dependency seam pointing homedir() at a fresh scratch dir
// and process.env at the supplied map, so resolution is hermetic and never
// touches the real home directory or environment.
function fakeHomeEnv(env: NodeJS.ProcessEnv = {}): {
  home: string;
  deps: { homedir: () => string; env: NodeJS.ProcessEnv };
} {
  const home = makeTmp('cas-module-state-home-');
  return { home, deps: { homedir: () => home, env } };
}

// Writes the marker file (the second tier of the precedence ladder) under the
// fake home, at the well-known relative path the resolver reads.
function writeMarker(home: string, contents: string): void {
  const markerPath = path.join(home, MODULE_STATE_MARKER_RELPATH);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, contents, 'utf8');
}

describe('resolveModuleStateRoot — precedence (store_root_precedence_resolution)', () => {
  it('GAN_MODULE_STATE env wins over marker and default', () => {
    // Both env and marker are set to different values; the env value must win,
    // and the marker value must not leak through.
    const { home, deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/gan-modstate-A' });

    writeMarker(home, '/tmp/gan-modstate-B');

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.normalize('/tmp/gan-modstate-A'));
    expect(root).not.toContain('gan-modstate-B');
  });

  it('marker contents used when env unset', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '/tmp/gan-modstate-from-marker');

    expect(resolveModuleStateRoot(deps)).toBe(path.normalize('/tmp/gan-modstate-from-marker'));
  });

  it('default expands homedir/.gan-module-state when env + marker absent (never a literal ~)', () => {
    const { home, deps } = fakeHomeEnv({});

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.join(home, DEFAULT_MODULE_STATE_DIRNAME));
    expect(root.startsWith(home)).toBe(true);
    expect(root).not.toContain('~');
  });

  it('treats an empty/whitespace GAN_MODULE_STATE as unset (falls through to marker)', () => {
    // A whitespace-only env value is not a real override; resolution must fall
    // through to the marker rather than producing a blank/cwd path.
    const { home, deps } = fakeHomeEnv({ GAN_MODULE_STATE: '   ' });
    writeMarker(home, '/tmp/gan-modstate-marker-wins');

    expect(resolveModuleStateRoot(deps)).toBe(path.normalize('/tmp/gan-modstate-marker-wins'));
  });

  it('treats an empty/whitespace marker as absent (falls through to default)', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '   \n');

    expect(resolveModuleStateRoot(deps)).toBe(path.join(home, DEFAULT_MODULE_STATE_DIRNAME));
  });
});

describe('resolveModuleStateRoot — absolutization (store_root_path_absolutized)', () => {
  it('expands a leading ~ in the env value to the home directory (no literal ~)', () => {
    const { home, deps } = fakeHomeEnv({ GAN_MODULE_STATE: '~/custom-module-store' });

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.join(home, 'custom-module-store'));
    expect(root).not.toContain('~');
  });

  it('expands a leading ~ in the marker to the home directory', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '~/marker-module-store');

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.join(home, 'marker-module-store'));
    expect(root).not.toContain('~');
  });

  it('resolves a relative env value against the home directory', () => {
    const { home, deps } = fakeHomeEnv({ GAN_MODULE_STATE: 'relative/module-store' });

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.resolve(home, 'relative/module-store'));
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('normalises an absolute env value', () => {
    const { deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/abs/../abs/module-store' });

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.normalize('/tmp/abs/module-store'));
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('strips trailing whitespace/newline from the marker before use', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '/tmp/gan-modstate-trimmed\n');

    expect(resolveModuleStateRoot(deps)).toBe(path.normalize('/tmp/gan-modstate-trimmed'));
  });
});

describe('module_state_root_separate_from_run_data_root', () => {
  it('the module-state default dirname differs from the run-data default dirname', () => {
    expect(DEFAULT_MODULE_STATE_DIRNAME).toBe('.gan-module-state');
    expect(DEFAULT_MODULE_STATE_DIRNAME).not.toBe(DEFAULT_STORE_DIRNAME);
  });

  it('the module-state env override key differs from the run-data env key', () => {
    expect(MODULE_STATE_ROOT_ENV).toBe('GAN_MODULE_STATE');
    expect(MODULE_STATE_ROOT_ENV).not.toBe(STORE_ROOT_ENV);
  });

  it('the two default roots are siblings under home but never the same path', () => {
    // Same parent (home) but distinct leaf dirs: aliasing the two would let
    // module-state and run-data writes collide.
    const { home, deps } = fakeHomeEnv({});
    const moduleRoot = resolveModuleStateRoot(deps);
    const runDataRoot = path.join(home, DEFAULT_STORE_DIRNAME);

    expect(moduleRoot).toBe(path.join(home, DEFAULT_MODULE_STATE_DIRNAME));
    expect(path.dirname(moduleRoot)).toBe(path.dirname(runDataRoot));
    expect(moduleRoot).not.toBe(runDataRoot);
  });
});

describe('resolveModuleStatePath — shape (module_state_path_shape_and_repo_key)', () => {
  it('resolves <store-root>/<repo-key>/<module>/<key>.json', () => {
    const { deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/module-store' });

    // The git stub reports the main worktree root, so the repo-key derives from
    // /Repo/App regardless of the (arbitrary) fromDir passed below.
    const mainRoot = '/Repo/App';
    const exec = makeGitStub(mainRoot);

    const filePath = resolveModuleStatePath('docker', 'port-registry', '/anywhere/in/repo', {
      deps,
      exec,
    });
    const expectedKey = computeRepoKey(mainRoot);
    expect(filePath).toBe(
      path.join(path.normalize('/tmp/module-store'), expectedKey, 'docker', 'port-registry.json'),
    );
    expect(filePath.endsWith(path.join('docker', 'port-registry.json'))).toBe(true);
  });

  it('the repo-store dir from the one-shot resolver matches the per-key path prefix', () => {
    const { deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/module-store' });
    const exec = makeGitStub('/Repo/App');

    const resolved = resolveModuleStateStore({ fromDir: '/x', deps, exec });
    const filePath = resolveModuleStatePath('docker', 'port-registry', '/x', { deps, exec });
    expect(filePath.startsWith(resolved.repoModuleStateDir + path.sep)).toBe(true);
    expect(resolved.repoModuleStateDir).toBe(path.join(resolved.storeRoot, resolved.repoKey));
  });
});

describe('path_determinism_via_shared_canonicalize', () => {
  it('repo-key for a path differing only by trailing slash is identical', () => {
    expect(computeRepoKey('/Repo/App')).toBe(computeRepoKey('/Repo/App/'));
  });

  it('on case-insensitive filesystems a case-only difference yields the same key + path', () => {
    if (platform() !== 'darwin' && platform() !== 'win32') {
      // On case-sensitive filesystems (Linux), /Repo/App and /repo/app are
      // genuinely different paths, so the keys must differ. The case-folding
      // assertions below only apply to darwin/win32.
      expect(computeRepoKey('/Repo/App')).not.toBe(computeRepoKey('/repo/app'));
      return;
    }
    expect(computeRepoKey('/Repo/App')).toBe(computeRepoKey('/repo/app'));
    expect(computeRepoKey('/Repo/App/')).toBe(computeRepoKey('/repo/app'));

    const { deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/module-store' });
    const a = resolveModuleStatePath('docker', 'port-registry', '/x', {
      deps,
      exec: makeGitStub('/Repo/App'),
    });
    const b = resolveModuleStatePath('docker', 'port-registry', '/x', {
      deps,
      exec: makeGitStub('/repo/app/'),
    });
    expect(a).toBe(b);
  });

  it('the repo-key matches the manual <basename>-<sha256[:12]> of the canonical path', () => {
    // Recompute the key by hand from the documented formula to pin the exact
    // derivation (basename of the canonical path + first 12 hex of its sha256).
    const repoRoot = makeTmp('myapp-');
    const canonical = canonicalizePath(repoRoot);
    const fullHash = createHash('sha256').update(canonical).digest('hex');
    const expected = path.basename(canonical) + '-' + fullHash.slice(0, 12);
    expect(computeRepoKey(repoRoot)).toBe(expected);
  });
});

// Thin argv-array git runner for the real-git integration cases below
// (gpgsign disabled so commits do not block on a signing key in CI).
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

// Creates a real, committed git repo in a scratch dir for the worktree tests.
function initRepo(): string {
  const repo = makeTmp('cas-module-main-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('integration — repo-key reuse across worktrees (repo_key_reuses_f7_not_cloned)', () => {
  it('two distinct worktree dirs of one repo resolve to the same key and the same module-state path', () => {
    const main = initRepo();
    const wt1 = path.join(makeTmp('cas-module-wt1-'), 'linked1');
    const wt2 = path.join(makeTmp('cas-module-wt2-'), 'linked2');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/a', wt1]);
    git(main, ['worktree', 'add', '-q', '-b', 'feature/b', wt2]);

    // All three worktrees belong to one repo, so they share one key (the
    // module state is repo-scoped, not worktree-scoped).
    const keyMain = resolveModuleRepoKey(main);
    const keyWt1 = resolveModuleRepoKey(wt1);
    const keyWt2 = resolveModuleRepoKey(wt2);
    expect(keyMain).toBe(keyWt1);
    expect(keyWt1).toBe(keyWt2);

    const deps = {
      homedir: () => makeTmp('cas-module-home-'),
      env: { GAN_MODULE_STATE: '/tmp/ms' },
    };
    const p1 = resolveModuleStatePath('docker', 'port-registry', wt1, { deps });
    const p2 = resolveModuleStatePath('docker', 'port-registry', wt2, { deps });
    const pMain = resolveModuleStatePath('docker', 'port-registry', main, { deps });
    expect(p1).toBe(p2);
    expect(p1).toBe(pMain);
    expect(p1).toContain(keyWt1);
  });
});

describe('repo-key memoisation (default git seam)', () => {
  it('memoises the git-derived key per fromDir: a second resolve does not re-invoke git', () => {
    const main = initRepo();
    _resetModuleRepoKeyCacheForTests();

    const key1 = resolveModuleRepoKey(main);
    expect(key1).toMatch(/-[0-9a-f]{12}$/);

    // Destroying .git would break a fresh git lookup; the second resolve still
    // returns the same key, proving it came from the memo, not a new git call.
    rmSync(path.join(main, '.git'), { recursive: true, force: true });

    expect(resolveModuleRepoKey(main)).toBe(key1);

    // After clearing the memo, the now-broken repo can no longer be resolved,
    // confirming the earlier success really was cached.
    _resetModuleRepoKeyCacheForTests();
    expect(() => resolveModuleRepoKey(main)).toThrow();
  });

  it('an injected git seam bypasses the memo, so each stub is honoured', () => {
    // Same fromDir but two different injected stubs: each call must honour its
    // own stub (the memo only applies to the default git seam), so the keys
    // differ.
    const fromDir = '/some/repo/dir';

    const k1 = resolveModuleRepoKey(fromDir, makeGitStub('/Repo/One'));
    const k2 = resolveModuleRepoKey(fromDir, makeGitStub('/Repo/Two'));
    expect(k1).toBe(computeRepoKey('/Repo/One'));
    expect(k2).toBe(computeRepoKey('/Repo/Two'));
    expect(k1).not.toBe(k2);
  });
});

// These cases read the source of module-state-store.ts as text and grep it.
// They guard *implementation discipline* that behaviour tests cannot see: that
// the file reuses the shared F7 repo-key / store-root helpers instead of
// re-deriving them, and that any subprocess call is argv-based (no shell-string
// exec). Re-implementing the derivation could silently diverge from run-store;
// a shell-string exec would reopen a command-injection surface.
describe('reuse + subprocess safety (static source check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const storeSrc = readFileSync(
    path.join(repoRoot, 'src', 'config-server', 'storage', 'module-state-store.ts'),
    'utf8',
  );

  it('imports the F7 repo-key derivation from run-store rather than re-implementing it', () => {
    expect(storeSrc).toContain("from './run-store.js'");
    expect(storeSrc).toContain('computeRepoKey');
    expect(storeSrc).toContain('resolveMainWorktreeRoot');

    expect(/rev-parse/.test(storeSrc)).toBe(false);
    expect(/createHash\s*\(/.test(storeSrc)).toBe(false);
    expect(/realpathSync/.test(storeSrc)).toBe(false);
    expect(/\.toLowerCase\s*\(/.test(storeSrc)).toBe(false);
  });

  it('reuses the shared store-root precedence ladder rather than re-implementing absolutize/marker', () => {
    expect(storeSrc).toContain("from './store-common.js'");
    expect(storeSrc).toContain('resolveStoreRootByPrecedence');

    expect(/readFileSync\s*\(/.test(storeSrc)).toBe(false);
    expect(/expanded\.startsWith\(['"]~/.test(storeSrc)).toBe(false);
  });

  it('any subprocess use goes through execFile/spawn argv arrays, never exec/execSync strings', () => {
    expect(/\bexecSync\b/.test(storeSrc)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(storeSrc)).toBe(false);

    expect(/exec\w*\(\s*`/.test(storeSrc)).toBe(false);
  });
});

// Fake execFileSync that answers only the `rev-parse --git-common-dir` probe
// (the one call repo-key derivation makes) by reporting <mainRoot>/.git, so the
// resolver believes mainRoot is the repo's main worktree. Any trailing slash on
// mainRoot is stripped so the reported path is well-formed.
function makeGitStub(mainRoot: string): typeof execFileSync {
  const normalized = mainRoot.replace(/[/\\]$/, '');
  const stub = ((_cmd: string, args?: readonly string[]) => {
    const argv = (args ?? []) as readonly string[];
    if (argv[0] === 'rev-parse' && argv.includes('--git-common-dir')) {
      return Buffer.from(path.join(normalized, '.git') + '\n');
    }
    return Buffer.from('');
  }) as unknown as typeof execFileSync;
  return stub;
}

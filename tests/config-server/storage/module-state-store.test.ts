/**
 * F8 slice 1 — central, repo-keyed module-state store resolution.
 *
 * Covers the Sprint 1 contract criteria with injectable home/env/git seams
 * (no reliance on the real environment or a real git invocation, except the
 * integration block which uses real temp repos + linked worktrees):
 *   - store_root_precedence_resolution (env > marker > default, empty fall-through)
 *   - store_root_path_absolutized (tilde / relative / absolute)
 *   - module_state_path_shape_and_repo_key (<root>/<repo-key>/<module>/<key>.json)
 *   - repo_key_reuses_f7_not_cloned (imports the F7 helpers; same key across worktrees)
 *   - module_state_root_separate_from_run_data_root
 *   - path_determinism_via_shared_canonicalize (case / trailing slash)
 *   - new_behavior_covered_by_tests
 *
 * NOTE ON LOCATION: the runnable test lives under `tests/` (not co-located in
 * `src/`) because this repo's `tsconfig.json` compiles `src/**` into `dist/`
 * and its vitest config only includes `tests/**`. A `*.test.ts` under `src/`
 * would be emitted into the production build (pulling vitest into `dist`) and
 * would never be picked up by `npm test`. This file mirrors the shipped F7
 * `tests/config-server/storage/run-store.test.ts` exactly.
 */

import { afterEach, describe, expect, it } from 'vitest';
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

// A StoreEnv whose `homedir` points at a throwaway dir, so the real
// `~/.claude/gan/module-state-dir` marker never leaks into these tests.
function fakeHomeEnv(env: NodeJS.ProcessEnv = {}): {
  home: string;
  deps: { homedir: () => string; env: NodeJS.ProcessEnv };
} {
  const home = makeTmp('cas-module-state-home-');
  return { home, deps: { homedir: () => home, env } };
}

function writeMarker(home: string, contents: string): void {
  const markerPath = path.join(home, MODULE_STATE_MARKER_RELPATH);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, contents, 'utf8');
}

describe('resolveModuleStateRoot — precedence (store_root_precedence_resolution)', () => {
  it('GAN_MODULE_STATE env wins over marker and default', () => {
    const { home, deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/gan-modstate-A' });
    // A marker pointing elsewhere must be ignored when the env var is set.
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
    // No marker file written.

    const root = resolveModuleStateRoot(deps);
    expect(root).toBe(path.join(home, DEFAULT_MODULE_STATE_DIRNAME));
    expect(root.startsWith(home)).toBe(true);
    expect(root).not.toContain('~');
  });

  it('treats an empty/whitespace GAN_MODULE_STATE as unset (falls through to marker)', () => {
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
    const { home, deps } = fakeHomeEnv({});
    const moduleRoot = resolveModuleStateRoot(deps);
    const runDataRoot = path.join(home, DEFAULT_STORE_DIRNAME);

    expect(moduleRoot).toBe(path.join(home, DEFAULT_MODULE_STATE_DIRNAME));
    expect(path.dirname(moduleRoot)).toBe(path.dirname(runDataRoot)); // siblings under home
    expect(moduleRoot).not.toBe(runDataRoot);
  });
});

describe('resolveModuleStatePath — shape (module_state_path_shape_and_repo_key)', () => {
  it('resolves <store-root>/<repo-key>/<module>/<key>.json', () => {
    const { deps } = fakeHomeEnv({ GAN_MODULE_STATE: '/tmp/module-store' });
    // Stub git so the repo-key derives deterministically from a fixed common-dir.
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
      // On case-sensitive Linux a case difference is a genuinely different repo.
      expect(computeRepoKey('/Repo/App')).not.toBe(computeRepoKey('/repo/app'));
      return;
    }
    expect(computeRepoKey('/Repo/App')).toBe(computeRepoKey('/repo/app'));
    expect(computeRepoKey('/Repo/App/')).toBe(computeRepoKey('/repo/app'));

    // And the full resolved path is identical for the two spellings.
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
    const repoRoot = makeTmp('myapp-');
    const canonical = canonicalizePath(repoRoot);
    const fullHash = createHash('sha256').update(canonical).digest('hex');
    const expected = path.basename(canonical) + '-' + fullHash.slice(0, 12);
    expect(computeRepoKey(repoRoot)).toBe(expected);
  });
});

// ---- integration: real temp repo + linked worktrees ----------------------
// repo_key_reuses_f7_not_cloned: two distinct worktree dirs sharing one
// git-common-dir resolve to the SAME key and SAME module-state path.

/** Run git with an argv array (never a shell string) inside `cwd`. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

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

    // Same key from each worktree (and from the main checkout).
    const keyMain = resolveModuleRepoKey(main);
    const keyWt1 = resolveModuleRepoKey(wt1);
    const keyWt2 = resolveModuleRepoKey(wt2);
    expect(keyMain).toBe(keyWt1);
    expect(keyWt1).toBe(keyWt2);

    // Same resolved module-state path from each worktree.
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

// ---- static reuse / safety check ----------------------------------------
// repo_key_reuses_f7_not_cloned (static half) + shell_and_subprocess_safety.

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
    // It must NOT re-derive the git-common-dir, SHA-256 keying, or case-folding.
    expect(/rev-parse/.test(storeSrc)).toBe(false);
    expect(/createHash\s*\(/.test(storeSrc)).toBe(false);
    expect(/realpathSync/.test(storeSrc)).toBe(false);
    expect(/\.toLowerCase\s*\(/.test(storeSrc)).toBe(false);
  });

  it('reuses the shared store-root precedence ladder rather than re-implementing absolutize/marker', () => {
    expect(storeSrc).toContain("from './store-common.js'");
    expect(storeSrc).toContain('resolveStoreRootByPrecedence');
    // No bespoke tilde expansion or marker read in the new module.
    expect(/readFileSync\s*\(/.test(storeSrc)).toBe(false);
    expect(/expanded\.startsWith\(['"]~/.test(storeSrc)).toBe(false);
  });

  it('any subprocess use goes through execFile/spawn argv arrays, never exec/execSync strings', () => {
    expect(/\bexecSync\b/.test(storeSrc)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(storeSrc)).toBe(false);
    // No template-literal command string is ever fed to a subprocess API.
    expect(/exec\w*\(\s*`/.test(storeSrc)).toBe(false);
  });
});

// ---- local helpers -------------------------------------------------------

/**
 * A git exec stub matching `execFileSync('git', argv, opts)` that returns
 * `<mainRoot>/.git` for `rev-parse --git-common-dir`, so the F7 derivation
 * resolves the main-worktree root to `<mainRoot>` deterministically without a
 * real repo. Returns a Buffer (as `execFileSync` does) so `.toString()` works.
 */
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

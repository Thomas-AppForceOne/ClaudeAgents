/**
 * F7 slice 1 — central run-data store resolution + repo keying.
 *
 * Covers the sprint-1 contract criteria:
 *   - store_root_precedence_env_wins
 *   - store_root_precedence_marker_then_default
 *   - repo_key_format
 *   - repo_key_derived_from_git_common_dir_parent (integration)
 *   - repo_key_uses_determinism_pins
 *   - repo_key_stable_across_linked_worktrees (integration)
 *   - run_dir_relocated_under_store
 *   - run_dir_survives_worktree_removal (integration)
 *   - store_paths_outside_any_worktree
 *
 * The shell-safety criterion (shell_subprocess_safety_git_calls) is enforced
 * statically over the source — see the assertions at the bottom of this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import {
  DEFAULT_STORE_DIRNAME,
  REPO_KEY_HASH_LENGTH,
  REPO_KEY_HASH_TAIL,
  RUN_ID_PATTERN,
  STORE_MARKER_RELPATH,
  computeRepoKey,
  generateRunId,
  resolveMainWorktreeRoot,
  resolveRepoKey,
  resolveRunDir,
  resolveRunStore,
  resolveStoreRoot,
} from '../../../src/config-server/storage/run-store.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'cas-run-store-'): string {
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

// Build a StoreEnv whose `homedir` points at a throwaway dir, so the real
// `~/.claude/gan/runs-data-dir` marker never leaks into these tests.
function fakeHomeEnv(env: NodeJS.ProcessEnv = {}): {
  home: string;
  deps: { homedir: () => string; env: NodeJS.ProcessEnv };
} {
  const home = makeTmp('cas-run-store-home-');
  return { home, deps: { homedir: () => home, env } };
}

function writeMarker(home: string, contents: string): void {
  const markerPath = path.join(home, STORE_MARKER_RELPATH);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, contents, 'utf8');
}

describe('resolveStoreRoot — precedence', () => {
  it('store_root_precedence_env_wins: GAN_RUNS_DATA wins over marker and default', () => {
    const { home, deps } = fakeHomeEnv({ GAN_RUNS_DATA: '/tmp/gan-runs-A' });
    // A marker pointing elsewhere must be ignored when the env var is set.
    writeMarker(home, '/tmp/gan-runs-B');

    const storeRoot = resolveStoreRoot(deps);
    expect(storeRoot).toBe(path.normalize('/tmp/gan-runs-A'));
    // Does NOT pick up the marker's value.
    expect(storeRoot).not.toContain('gan-runs-B');
  });

  it('store_root_precedence_marker_then_default (a): marker contents used when env unset', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '/tmp/gan-runs-from-marker');

    const storeRoot = resolveStoreRoot(deps);
    expect(storeRoot).toBe(path.normalize('/tmp/gan-runs-from-marker'));
  });

  it('store_root_precedence_marker_then_default (b): default expands homedir, never a literal ~', () => {
    const { home, deps } = fakeHomeEnv({});
    // No marker file written.

    const storeRoot = resolveStoreRoot(deps);
    expect(storeRoot).toBe(path.join(home, DEFAULT_STORE_DIRNAME));
    expect(storeRoot.startsWith(home)).toBe(true);
    expect(storeRoot).not.toContain('~');
  });

  it('expands a leading ~ in the marker to the home directory (no literal ~)', () => {
    const { home, deps } = fakeHomeEnv({});
    writeMarker(home, '~/custom-store');

    const storeRoot = resolveStoreRoot(deps);
    expect(storeRoot).toBe(path.join(home, 'custom-store'));
    expect(storeRoot).not.toContain('~');
  });

  it('treats an empty/whitespace GAN_RUNS_DATA as unset (falls through to marker)', () => {
    const { home, deps } = fakeHomeEnv({ GAN_RUNS_DATA: '   ' });
    writeMarker(home, '/tmp/gan-runs-marker-wins');

    expect(resolveStoreRoot(deps)).toBe(path.normalize('/tmp/gan-runs-marker-wins'));
  });
});

describe('computeRepoKey — format and determinism', () => {
  it('repo_key_format: <basename>-<first 12 hex of sha256(canonical path)>', () => {
    const repoRoot = makeTmp('myapp-');
    const canonical = canonicalizePath(repoRoot);
    const fullHash = createHash('sha256').update(canonical).digest('hex');
    const expected = path.basename(canonical) + '-' + fullHash.slice(0, 12);

    const key = computeRepoKey(repoRoot);
    expect(key).toBe(expected);
    // The 12-char tail is the literal prefix of the full digest.
    expect(REPO_KEY_HASH_TAIL.test(key)).toBe(true);
    const tail = key.slice(key.length - REPO_KEY_HASH_LENGTH);
    expect(tail).toBe(fullHash.slice(0, REPO_KEY_HASH_LENGTH));
    expect(/^[0-9a-f]{12}$/.test(tail)).toBe(true);
  });

  it('repo_key_uses_determinism_pins: trailing slash + case differences hash equal on darwin', () => {
    // Behavioural check that the case-folding canonicalizePath is used. On
    // darwin/win32 two spellings differing only by case + trailing slash must
    // produce the SAME key; on Linux (case-sensitive) they legitimately differ
    // by case, so we only assert the trailing-slash invariance there.
    const base = '/Repo/App';
    const variantSlash = '/Repo/App/';
    const variantCase = '/repo/app';

    expect(computeRepoKey(base)).toBe(computeRepoKey(variantSlash));

    if (platform() === 'darwin' || platform() === 'win32') {
      expect(computeRepoKey(base)).toBe(computeRepoKey(variantCase));
      expect(computeRepoKey('/Repo/App/')).toBe(computeRepoKey('/repo/app'));
    }
  });
});

describe('resolveRunDir — relocation under the store', () => {
  it('run_dir_relocated_under_store: <store>/<key>/runs/<id>, not under .gan-state/runs', () => {
    const storeRoot = '/tmp/store';
    const key = 'myapp-3f9a1c0b8e21';
    const runId = '20260522T180000-9c4f';

    const runDir = resolveRunDir(storeRoot, key, runId);
    expect(runDir).toBe(path.join('/tmp/store', key, 'runs', runId));
    expect(runDir).not.toContain('.gan-state/runs');
  });

  it('generateRunId produces the O2 grammar <YYYYMMDDTHHMMSS>-<4 hex>', () => {
    const id = generateRunId(new Date(Date.UTC(2026, 4, 22, 18, 0, 0)));
    expect(id.startsWith('20260522T180000-')).toBe(true);
    expect(RUN_ID_PATTERN.test(id)).toBe(true);
    // A freshly-generated id (random suffix) also matches.
    expect(RUN_ID_PATTERN.test(generateRunId())).toBe(true);
  });

  it('store_paths_outside_any_worktree: resolved run dir is under the store, not a worktree', () => {
    const storeRoot = makeTmp('cas-store-');
    const worktreeRoot = makeTmp('cas-worktree-');
    const key = 'myapp-deadbeef0000';
    const runId = '20260522T180000-9c4f';

    const runDir = resolveRunDir(storeRoot, key, runId);
    expect(runDir.startsWith(canonicalizePath(storeRoot)) || runDir.startsWith(storeRoot)).toBe(
      true,
    );
    expect(runDir.startsWith(canonicalizePath(worktreeRoot))).toBe(false);
    expect(runDir).not.toContain('.gan-state/runs');
  });
});

// ---- integration: real temp repo + linked worktrees ----------------------

/** Run git with an argv array (never a shell string) inside `cwd`. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

function initRepo(): string {
  const repo = makeTmp('cas-main-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('integration — main-worktree derivation and key stability', () => {
  it('repo_key_derived_from_git_common_dir_parent: from a linked worktree, root is the main checkout', () => {
    const main = initRepo();
    const wt = path.join(makeTmp('cas-wt-parent-'), 'linked');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/x', wt]);

    const derivedFromWt = resolveMainWorktreeRoot(wt);
    expect(canonicalizePath(derivedFromWt)).toBe(canonicalizePath(main));
    expect(canonicalizePath(derivedFromWt)).not.toBe(canonicalizePath(wt));
  });

  it('repo_key_stable_across_linked_worktrees: main + two linked worktrees share one key', () => {
    const main = initRepo();
    const wt1 = path.join(makeTmp('cas-wt1-'), 'linked1');
    const wt2 = path.join(makeTmp('cas-wt2-'), 'linked2');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/a', wt1]);
    git(main, ['worktree', 'add', '-q', '-b', 'feature/b', wt2]);

    const keyMain = resolveRepoKey(main);
    const keyWt1 = resolveRepoKey(wt1);
    const keyWt2 = resolveRepoKey(wt2);

    expect(keyMain).toBe(keyWt1);
    expect(keyWt1).toBe(keyWt2);
  });
});

describe('integration — run data survives worktree removal', () => {
  it('run_dir_survives_worktree_removal: store run dir + trace/ outlive git worktree remove --force', () => {
    const storeRoot = makeTmp('cas-store-survive-');
    const main = initRepo();
    const wt = path.join(makeTmp('cas-wt-survive-'), 'linked');
    git(main, ['worktree', 'add', '-q', '-b', 'feature/survive', wt]);

    const runId = '20260522T180000-9c4f';
    // Resolve the run store FROM the linked worktree, with the env override.
    const resolved = resolveRunStore({
      runId,
      fromDir: wt,
      deps: { homedir: () => makeTmp('cas-home-survive-'), env: { GAN_RUNS_DATA: storeRoot } },
    });

    // The run dir is built verbatim from the (env-supplied) store root, so it
    // sits under the store and never under the worktree.
    expect(resolved.runDir.startsWith(storeRoot + path.sep)).toBe(true);
    expect(resolved.runDir).not.toContain('.gan-state/runs');
    expect(resolved.runDir.startsWith(canonicalizePath(wt))).toBe(false);
    expect(resolved.runDir.startsWith(wt + path.sep)).toBe(false);

    // Write a marker file + a trace/ subdir inside the run dir.
    const traceDir = path.join(resolved.runDir, 'trace');
    mkdirSync(traceDir, { recursive: true });
    const markerFile = path.join(resolved.runDir, 'progress.json');
    const markerContent = '{"sprint":1}\n';
    writeFileSync(markerFile, markerContent, 'utf8');
    const traceEvent = path.join(traceDir, '0000000001.json');
    const traceContent = '{"event":"start"}\n';
    writeFileSync(traceEvent, traceContent, 'utf8');

    // Remove the worktree the run was started from.
    git(main, ['worktree', 'remove', '--force', wt]);
    expect(existsSync(wt)).toBe(false);

    // The store run directory and its contents survive, byte-identical.
    expect(existsSync(resolved.runDir)).toBe(true);
    expect(existsSync(traceDir)).toBe(true);
    expect(readFileSync(markerFile, 'utf8')).toBe(markerContent);
    expect(readFileSync(traceEvent, 'utf8')).toBe(traceContent);
  });
});

// ---- static security check: shell_subprocess_safety_git_calls ------------

describe('shell_subprocess_safety_git_calls (static source check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const storeSrc = readFileSync(
    path.join(repoRoot, 'src', 'config-server', 'storage', 'run-store.ts'),
    'utf8',
  );

  it('uses execFile/execFileSync/spawn with an args array, never exec/execSync', () => {
    expect(storeSrc).toContain('execFileSync');
    // The shell-string subprocess APIs `exec`/`execSync` must not be imported
    // from child_process, and must not be called. `execFile`/`execFileSync`
    // (argv-array form) and a locally-named `exec` parameter that defaults to
    // execFileSync are fine — the prohibition is on the bare `exec`/`execSync`
    // command-string APIs.
    expect(/\bexec\b\s*,/.test(storeSrc)).toBe(false); // not in an import list
    expect(/\bexecSync\b/.test(storeSrc)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(storeSrc)).toBe(false);
    // Every git call passes an argv array (no interpolated command string).
    expect(/exec\w*\(\s*['"]git['"]\s*,\s*\[/.test(storeSrc)).toBe(true);
    // No template-literal command string is ever fed to a subprocess API.
    expect(/exec\w*\(\s*`/.test(storeSrc)).toBe(false);
  });

  it('does not re-implement realpath/lowercase/slash-strip outside the determinism import', () => {
    // repo_key_uses_determinism_pins (static half): the store source must not
    // call realpathSync directly nor .toLowerCase() on a path; it imports
    // canonicalizePath from the determinism module instead.
    expect(storeSrc).toContain("from '../determinism/index.js'");
    expect(storeSrc).toContain('canonicalizePath');
    expect(/realpathSync/.test(storeSrc)).toBe(false);
    expect(/\.toLowerCase\s*\(/.test(storeSrc)).toBe(false);
  });

  it('passes the git rev-parse invocation as an argv array', () => {
    expect(storeSrc).toContain("['rev-parse', '--git-common-dir']");
  });
});

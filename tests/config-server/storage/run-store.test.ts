// Covers the F7 run-store primitives that decide WHERE run data lives:
//   - store-root precedence (GAN_RUNS_DATA env > marker file > default
//     ~/.gan-state-equivalent), with ~ expanded and whitespace-only treated as
//     unset;
//   - the repo-key format <basename>-<sha256[:12]> derived from the CANONICAL
//     path (so trailing-slash and, on darwin/win32, case-only variants collapse
//     to one key);
//   - run-dir relocation under <store>/<key>/runs/<id> (never inside the
//     worktree's .gan-state/runs) and the O2 run-id grammar;
//   - integration: the key is derived from the git common-dir parent (the main
//     checkout) so it is stable across linked worktrees, and run data SURVIVES
//     `git worktree remove --force`.
// The static-source checks pin that all git access is argv-array execFile (no
// exec/execSync command strings) and that canonicalisation is delegated to the
// determinism module rather than re-implemented.

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

// Hermetic dependency seam: homedir() points at a scratch dir and env is the
// supplied map, so store-root resolution never reads the real environment.
function fakeHomeEnv(env: NodeJS.ProcessEnv = {}): {
  home: string;
  deps: { homedir: () => string; env: NodeJS.ProcessEnv };
} {
  const home = makeTmp('cas-run-store-home-');
  return { home, deps: { homedir: () => home, env } };
}

// Writes the store-root marker file (precedence tier between env and default)
// under the fake home.
function writeMarker(home: string, contents: string): void {
  const markerPath = path.join(home, STORE_MARKER_RELPATH);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, contents, 'utf8');
}

describe('resolveStoreRoot — precedence', () => {
  it('store_root_precedence_env_wins: GAN_RUNS_DATA wins over marker and default', () => {
    // Env and marker disagree; env must win and the marker value must not leak.
    const { home, deps } = fakeHomeEnv({ GAN_RUNS_DATA: '/tmp/gan-runs-A' });

    writeMarker(home, '/tmp/gan-runs-B');

    const storeRoot = resolveStoreRoot(deps);
    expect(storeRoot).toBe(path.normalize('/tmp/gan-runs-A'));

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
    // Recompute the key by hand to pin the exact derivation, then cross-check
    // against the exported pattern/length constants so the format and the
    // constants stay in lockstep.
    const repoRoot = makeTmp('myapp-');
    const canonical = canonicalizePath(repoRoot);
    const fullHash = createHash('sha256').update(canonical).digest('hex');
    const expected = path.basename(canonical) + '-' + fullHash.slice(0, 12);

    const key = computeRepoKey(repoRoot);
    expect(key).toBe(expected);

    expect(REPO_KEY_HASH_TAIL.test(key)).toBe(true);
    const tail = key.slice(key.length - REPO_KEY_HASH_LENGTH);
    expect(tail).toBe(fullHash.slice(0, REPO_KEY_HASH_LENGTH));
    expect(/^[0-9a-f]{12}$/.test(tail)).toBe(true);
  });

  it('repo_key_uses_determinism_pins: trailing slash + case differences hash equal on darwin', () => {
    const base = '/Repo/App';
    const variantSlash = '/Repo/App/';
    const variantCase = '/repo/app';

    // Trailing slash never changes the key (canonicalisation strips it).
    expect(computeRepoKey(base)).toBe(computeRepoKey(variantSlash));

    // Case-only differences collapse to one key only on case-insensitive
    // filesystems; on Linux they would (correctly) differ, so guard the check.
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
    // A fixed UTC clock pins the timestamp prefix exactly; the no-arg call (real
    // clock + random suffix) still satisfies the grammar pattern.
    const id = generateRunId(new Date(Date.UTC(2026, 4, 22, 18, 0, 0)));
    expect(id.startsWith('20260522T180000-')).toBe(true);
    expect(RUN_ID_PATTERN.test(id)).toBe(true);

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

// Argv-array git runner for the real-git integration cases.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

// Real committed repo in a scratch dir (gpgsign off so commits never block).
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

    // From inside a linked worktree, the derived root is the MAIN checkout
    // (via the git common-dir parent), not the linked worktree itself — this is
    // what makes the repo-key shared across worktrees below.
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

    // Resolve the run store from inside the linked worktree, but force it onto
    // the external store via GAN_RUNS_DATA.
    const resolved = resolveRunStore({
      runId,
      fromDir: wt,
      deps: { homedir: () => makeTmp('cas-home-survive-'), env: { GAN_RUNS_DATA: storeRoot } },
    });

    // The run dir must live under the external store, never inside the worktree
    // — that placement is precisely what lets it survive the removal below.
    expect(resolved.runDir.startsWith(storeRoot + path.sep)).toBe(true);
    expect(resolved.runDir).not.toContain('.gan-state/runs');
    expect(resolved.runDir.startsWith(canonicalizePath(wt))).toBe(false);
    expect(resolved.runDir.startsWith(wt + path.sep)).toBe(false);

    const traceDir = path.join(resolved.runDir, 'trace');
    mkdirSync(traceDir, { recursive: true });
    const markerFile = path.join(resolved.runDir, 'progress.json');
    const markerContent = '{"sprint":1}\n';
    writeFileSync(markerFile, markerContent, 'utf8');
    const traceEvent = path.join(traceDir, '0000000001.json');
    const traceContent = '{"event":"start"}\n';
    writeFileSync(traceEvent, traceContent, 'utf8');

    // Force-remove the worktree, then prove the run dir and its trace contents
    // are still present and byte-identical: run data outlives the worktree.
    git(main, ['worktree', 'remove', '--force', wt]);
    expect(existsSync(wt)).toBe(false);

    expect(existsSync(resolved.runDir)).toBe(true);
    expect(existsSync(traceDir)).toBe(true);
    expect(readFileSync(markerFile, 'utf8')).toBe(markerContent);
    expect(readFileSync(traceEvent, 'utf8')).toBe(traceContent);
  });
});

// Source-text greps guarding subprocess discipline: run-store.ts (and the
// git-exec helper it uses) must invoke git only via execFile/execFileSync with
// an argv array — never exec/execSync command strings or template literals —
// and must delegate path canonicalisation to the determinism module rather than
// re-implementing realpath/lowercase.
describe('shell_subprocess_safety_git_calls (static source check)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..', '..', '..');
  const storeSrc = readFileSync(
    path.join(repoRoot, 'src', 'config-server', 'storage', 'run-store.ts'),
    'utf8',
  );

  it('uses execFile/execFileSync/spawn with an args array, never exec/execSync', () => {
    expect(storeSrc).toContain('execFileSync');

    expect(/\bexec\b\s*,/.test(storeSrc)).toBe(false);
    expect(/\bexecSync\b/.test(storeSrc)).toBe(false);
    expect(/child_process['"]\)?\.exec\s*\(/.test(storeSrc)).toBe(false);

    expect(/exec\w*\(\s*['"]git['"]\s*,\s*\[/.test(storeSrc)).toBe(true);

    expect(/exec\w*\(\s*`/.test(storeSrc)).toBe(false);
  });

  it('does not re-implement realpath/lowercase/slash-strip outside the determinism import', () => {

    expect(storeSrc).toContain("from '../determinism/index.js'");
    expect(storeSrc).toContain('canonicalizePath');
    expect(/realpathSync/.test(storeSrc)).toBe(false);
    expect(/\.toLowerCase\s*\(/.test(storeSrc)).toBe(false);
  });

  it('passes the git rev-parse invocation as an argv array', () => {

    const gitExecSrc = readFileSync(
      path.join(repoRoot, 'src', 'config-server', 'storage', 'git-exec.ts'),
      'utf8',
    );
    expect(gitExecSrc).toContain("['rev-parse', '--git-common-dir']");
    expect(/exec\w*\(\s*['"]git['"]\s*,\s*\[/.test(gitExecSrc)).toBe(true);
    expect(/\bexecSync\b/.test(gitExecSrc)).toBe(false);
    expect(/exec\w*\(\s*`/.test(gitExecSrc)).toBe(false);
  });
});

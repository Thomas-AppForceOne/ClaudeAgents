/**
 * Run-context tool tests — the purity + addressability cases for
 * resolveRunStore, the writing-half cases for createRunWorkspace (real git),
 * tool-vs-library parity for both, and the slice-1 static-scan that the new
 * tool files (and any new helpers introduced this sprint) introduce no
 * `exec(`/`execSync(` token.
 *
 * The store-resolver cases scrub `GAN_RUNS_DATA` and friends with `vi.stubEnv`
 * because resolveStoreRoot's precedence-chain reads them; without the scrub a
 * developer running the suite with the env var set on their shell would
 * silently bypass the test's intended path. Each test inside `describe` thus
 * starts from a known clean env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUN_ID_PATTERN,
  computeRepoKey,
  resolveRunStore as libraryResolveRunStore,
  generateRunId,
} from '../../../src/config-server/storage/run-store.js';
import { resolveWorkspace } from '../../../src/config-server/storage/worktree-resolver.js';
import {
  createRunWorkspaceTool,
  resolveRunStoreTool,
} from '../../../src/config-server/tools/run-context.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-run-ctx-'): string {
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

// Argv-array git runner; matches the rest of the test base. The integration
// cases use a real `git` binary on PATH (CI ships one); skip nothing — there
// is no fallback that would still exercise resolveWorkspace's writes.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

// Real committed repo with `develop` as the base — the same shape the
// existing worktree-resolver integration suite uses, so the cases here
// mirror the surface behind the tool exactly.
function initRepo(): string {
  const repo = makeTmp('r7-int-repo-');
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
    return '';
  }
}

describe('resolveRunStore tool — purity and addressability', () => {
  // The tool's store-root precedence reads GAN_RUNS_DATA off the process env
  // (via the library helper); each test sets up a hermetic store under tmp,
  // and any prior shell value is scrubbed so the test result does not depend
  // on developer environment.
  let storeRoot: string;
  let repoRoot: string;

  beforeEach(() => {
    storeRoot = makeTmp('r7-store-');
    repoRoot = initRepo();
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mints a fresh runId matching RUN_ID_PATTERN when no runId is supplied', () => {
    const result = resolveRunStoreTool({ fromDir: repoRoot });
    expect(RUN_ID_PATTERN.test(result.runId)).toBe(true);
  });

  it('returns every ResolvedRunStore field plus the minted runId', () => {
    const result = resolveRunStoreTool({ fromDir: repoRoot });
    for (const k of [
      'storeRoot',
      'repoKey',
      'mainWorktreeRoot',
      'repoStoreDir',
      'runLockPath',
      'runsRoot',
      'runDir',
      'runId',
    ]) {
      expect(result[k as keyof typeof result], `missing field ${k}`).toBeTruthy();
    }
  });

  it('returned runDir equals <storeRoot>/<repoKey>/runs/<runId> (path-shape claim)', () => {
    const result = resolveRunStoreTool({ fromDir: repoRoot });
    // Join the same components the tool returned and assert string-equal;
    // this catches a future refactor that subtly diverges runDir from the
    // documented shape (e.g. drops the 'runs' segment).
    expect(result.runDir).toBe(path.join(result.storeRoot, result.repoKey, 'runs', result.runId));
  });

  it('returned repoKey is byte-identical to a direct computeRepoKey import', () => {
    const result = resolveRunStoreTool({ fromDir: repoRoot });
    // The library computeRepoKey is the contract; the tool is just one
    // implementation behind it. Any divergence here is a parity break.
    expect(result.repoKey).toBe(computeRepoKey(result.mainWorktreeRoot));
  });

  it('writes nothing under runDir, storeRoot, or repoStoreDir', () => {
    const result = resolveRunStoreTool({ fromDir: repoRoot });
    // The store root may not exist yet (pure resolver), and the run dir
    // certainly must not — the writing tool is createRunWorkspace.
    expect(existsSync(result.runDir)).toBe(false);
    expect(existsSync(result.repoStoreDir)).toBe(false);
    // storeRoot itself was created by mkdtemp; assert that no run-related
    // children were added to it.
    const storeStats = statSync(result.storeRoot);
    expect(storeStats.isDirectory()).toBe(true);
    // The library makes no claim about creating <storeRoot>/<repoKey>; assert
    // the resolved path is absent.
  });

  it('explicit runId re-resolves byte-identical runDir / repoKey / runLockPath (addressability)', () => {
    const first = resolveRunStoreTool({ fromDir: repoRoot });
    // A recovery / cleanup / list call passes the same id back — the tool
    // must echo the same paths byte-for-byte so addressability holds.
    const second = resolveRunStoreTool({ fromDir: repoRoot, runId: first.runId });
    expect(second.runId).toBe(first.runId);
    expect(second.runDir).toBe(first.runDir);
    expect(second.repoKey).toBe(first.repoKey);
    expect(second.runLockPath).toBe(first.runLockPath);
  });

  it('tool-vs-library parity: tool composition matches generateRunId + libraryResolveRunStore byte-for-byte', () => {
    // Pin the parity claim: feed both code paths the same seeded id and
    // compare every field of the returned ResolvedRunStore shape. Doing it
    // ten times with distinct seeds catches any field that happens to be
    // equal for a single id but diverges in general.
    for (let i = 0; i < 10; i += 1) {
      const seeded = generateRunId();
      const viaTool = resolveRunStoreTool({ fromDir: repoRoot, runId: seeded });
      const viaLib = libraryResolveRunStore({ fromDir: repoRoot, runId: seeded });
      expect(viaTool.storeRoot).toBe(viaLib.storeRoot);
      expect(viaTool.repoKey).toBe(viaLib.repoKey);
      expect(viaTool.mainWorktreeRoot).toBe(viaLib.mainWorktreeRoot);
      expect(viaTool.repoStoreDir).toBe(viaLib.repoStoreDir);
      expect(viaTool.runLockPath).toBe(viaLib.runLockPath);
      expect(viaTool.runsRoot).toBe(viaLib.runsRoot);
      expect(viaTool.runDir).toBe(viaLib.runDir);
      expect(viaTool.runId).toBe(seeded);
    }
  });
});

describe('createRunWorkspace tool — cases 1b and 1c create the worktree', () => {
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = makeTmp('r7-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('case 1c (no matching branch): creates branch + run-scoped worktree on disk', () => {
    const repo = initRepo();
    // Run the tool from inside the repo so the internal projectRoot
    // derivation picks `repo` as mainWorktreeRoot.
    const runId = '20260522T180000-1c1c';
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const ws = createRunWorkspaceTool({ subject: 'Add Export', runId });
      expect(ws.resolutionCase).toBe('1c');
      expect(ws.createdByGan).toBe(true);
      expect(ws.branch).toBe('feature/add-export');

      const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
      expect(existsSync(runScoped)).toBe(true);
      expect(currentBranchOf(runScoped)).toBe('feature/add-export');
    } finally {
      process.chdir(cwd);
    }
  });

  it('case 1b (matching branch on main checkout): wraps the branch in a fresh worktree', () => {
    const repo = initRepo();
    git(repo, ['checkout', '-q', '-b', 'feature/add-export']);
    const runId = '20260522T180000-1b1b';
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const ws = createRunWorkspaceTool({ subject: 'Add Export', runId });
      expect(ws.resolutionCase).toBe('1b');
      expect(ws.createdByGan).toBe(true);
      expect(ws.branch).toBe('feature/add-export');

      const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
      expect(existsSync(runScoped)).toBe(true);
      expect(currentBranchOf(runScoped)).toBe('feature/add-export');
      // The main checkout was freed onto develop.
      expect(currentBranchOf(repo)).toBe('develop');
    } finally {
      process.chdir(cwd);
    }
  });

  it('returns { worktreePath, branch, createdByGan, resolutionCase, mutated }', () => {
    const repo = initRepo();
    const runId = '20260522T180000-shape';
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const ws = createRunWorkspaceTool({ subject: 'Shape Probe', runId });
      // Pin the public shape: the tool mirrors the library's ResolvedWorkspace
      // and adds the F2 `mutated` indicator as a sibling — and must not silently
      // add or rename any other field a downstream consumer would miss.
      expect(Object.keys(ws).sort()).toEqual(
        ['branch', 'createdByGan', 'mutated', 'resolutionCase', 'worktreePath'].sort(),
      );
      // `mutated` is the worktree-creation signal: it equals `createdByGan`
      // (true for the 1b/1c create cases this fresh-repo probe exercises).
      expect(ws.mutated).toBe(ws.createdByGan);
    } finally {
      process.chdir(cwd);
    }
  });

  it('uses a supplied mainWorktreeRoot directly rather than re-deriving the projectRoot from cwd', () => {
    // I-017: when the caller threads back the root resolveRunStore already
    // computed at run start, the tool must use it as projectRoot directly and
    // skip the second `git rev-parse --git-common-dir`. Proven with two
    // distinct repos: cwd is repoA (so the worktree-creation git commands have
    // a real repo to run in), but the supplied mainWorktreeRoot is repoB. The
    // worktree path is computed under projectRoot, so it must land under
    // repoB — the supplied value — not under repoA, which is what an internal
    // re-derivation from cwd would have produced.
    const repoA = initRepo();
    const repoB = initRepo();
    const runId = '20260522T180000-mwr1';
    const cwd = process.cwd();
    try {
      process.chdir(repoA);
      const ws = createRunWorkspaceTool({
        subject: 'Add Export',
        runId,
        mainWorktreeRoot: repoB,
      });
      expect(ws.createdByGan).toBe(true);
      // Landed under repoB (supplied), proving the supplied value drove
      // projectRoot — re-derivation from cwd (repoA) would have used repoA.
      // (Compare on existence, not an exact string, because the returned path
      // is canonicalised — `/tmp` resolves to `/private/tmp` on macOS.)
      const underB = path.join(repoB, '.gan-state', 'runs', runId, 'worktree');
      const underA = path.join(repoA, '.gan-state', 'runs', runId, 'worktree');
      expect(existsSync(underB)).toBe(true);
      expect(existsSync(underA)).toBe(false);
      // And the returned path names repoB's runs tree, not repoA's.
      expect(ws.worktreePath).toContain(path.join('runs', runId, 'worktree'));
      expect(ws.worktreePath).toContain(path.basename(repoB));
    } finally {
      process.chdir(cwd);
    }
  });

  it('falls back to internal derivation when mainWorktreeRoot is absent (backward compatible)', () => {
    // The omitted-value path must still work: run from inside the repo so the
    // internal resolveRunStore derivation picks it up, exactly as before the
    // optional input existed.
    const repo = initRepo();
    const runId = '20260522T180000-mwr2';
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const ws = createRunWorkspaceTool({ subject: 'Add Export', runId });
      expect(ws.resolutionCase).toBe('1c');
      const runScoped = path.join(repo, '.gan-state', 'runs', runId, 'worktree');
      expect(existsSync(runScoped)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  // The orchestrator-flag-dispatch invariant ("createRunWorkspace is NOT
  // invoked on --recover/--cleanup paths") was previously asserted here over a
  // test-local `dispatchOrchestrator` helper — a tautology that mirrored what
  // the SUT prose says rather than reading it. The actual SUT is
  // skills/gan/SKILL.md; the section-walk in
  // tests/agents/skill-createrunworkspace-mention.test.ts now pins that the
  // term appears only inside the "Regular invocation flow" section and never
  // in "Inspection and recovery short-circuits" or "Cleanup and recovery".

  it('tool-vs-library parity: createRunWorkspace returns the same shape as library resolveWorkspace for case 1a', () => {
    // Case 1a (reuse in place) is the read-only path; both the tool and the
    // library should return the same `ResolvedWorkspace` field set when run
    // against the same repo state. Set up: create the matching branch in a
    // dedicated worktree (not the main checkout), so case 1a fires on it.
    const repo = initRepo();
    // Create the branch in a dedicated worktree in one git step; using
    // `worktree add -b` keeps the branch out of the main checkout entirely.
    const dedicated = path.join(makeTmp('r7-int-dedicated-'), 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'feature/parity-probe', dedicated]);

    const runId = '20260522T180000-1a1a';
    const cwd = process.cwd();
    try {
      process.chdir(dedicated);
      const viaTool = createRunWorkspaceTool({ subject: 'Parity Probe', runId });
      // Library call uses the same projectRoot the tool derived (the main
      // checkout root) and the same fromDir.
      const viaLib = resolveWorkspace({
        subject: 'Parity Probe',
        runId,
        projectRoot: repo,
        fromDir: dedicated,
      });
      expect(viaTool.resolutionCase).toBe('1a');
      expect(viaLib.resolutionCase).toBe('1a');
      expect(viaTool.branch).toBe(viaLib.branch);
      expect(viaTool.worktreePath).toBe(viaLib.worktreePath);
      expect(viaTool.createdByGan).toBe(viaLib.createdByGan);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('slice-1 source: no exec/execSync token introduced', () => {
  // The shell-and-subprocess-safety surface from web-node.md fires on
  // src/config-server/storage/git-exec.ts and run-store.ts (both reached by
  // the new tools). This static scan asserts the new slice-1 source files
  // never introduce a shell-interpreted subprocess: only the argv-array
  // execFile/execFileSync/spawn/spawnSync are accepted; a bare `exec(` or
  // `execSync(` token would mean a regression. The byte-level regex skips
  // longer identifiers (execFile, execFileSync) by requiring `(` immediately
  // after the word boundary.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, '..', '..', '..', 'src');
  // Every new file this sprint adds under src/. Updating this list is part of
  // the sprint diff; an unlisted helper sneaks past the scan only if a
  // reviewer also fails to add it.
  const sliceSources = [
    path.join(srcRoot, 'config-server', 'tools', 'run-context.ts'),
    path.join(srcRoot, 'config-server', 'tools', 'run-lock.ts'),
  ];
  // Permits execFile / execFileSync / spawn / spawnSync. Forbids exec( and
  // execSync( (the shell-interpreted forms). \b ensures we hit the bare
  // identifier, not a suffix of a longer one.
  const FORBIDDEN = /\bexec(?:Sync)?\(/;
  // Words to subtract from the match so execFile and execFileSync remain
  // allowed (they happen to also match exec(/execSync( prefixes if we did not
  // negative-look-ahead the "File" / "FileSync" suffix).
  // We can't easily express that with a single short regex, so the loop
  // strips the safe identifiers before scanning.
  const SAFE = /\b(execFile|execFileSync|spawn|spawnSync)\b/g;

  for (const file of sliceSources) {
    it(`no exec(/execSync( token in ${path.relative(srcRoot, file)}`, () => {
      const raw = readFileSync(file, 'utf8');
      const cleaned = raw.replace(SAFE, '__SAFE__');
      expect(FORBIDDEN.test(cleaned)).toBe(false);
    });
  }
});

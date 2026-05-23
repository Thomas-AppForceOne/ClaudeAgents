/**
 * End-to-end tests for `gan hooks status` (acceptance criteria A8/A9, F7).
 *
 * `hooks status` inspects the PreToolUse confinement hook (`gan-confine.sh`) at
 * two tiers — the user-tier hook (under HOME) and an optional project-tier
 * override (under the cwd) — and reports their presence, the framework version
 * each was authored against, which takes precedence, and the active-run
 * confinement zones derived from GAN_* env vars.
 *
 * What the suite guards:
 * - dispatch: bare `gan hooks` and unknown inner subcommands are usage errors
 *   (64) with a help pointer, while `gan hooks status` reaches the handler;
 * - reporting (A8/A9): user-tier-only vs both-tiers, the precedence note, and
 *   the legacy-deletion hint that fires only when a project hook references the
 *   retired `.gan/` path (a current `.gan-state/...` hook must NOT trigger it);
 * - robustness: this command reads files written by who-knows-what, so it must
 *   never execute their contents. The shell-injection-bait test is the
 *   security-critical one — it seeds a project hook full of `$(...)`/backtick
 *   command substitutions and asserts a sentinel file is never created, proving
 *   the hook body is classified as inert text, not run. Oversized (5 MiB) and
 *   binary/NUL content must likewise classify and continue, never crash;
 * - F7 run zones: GAN_WORKTREE / GAN_RUN_DIR / GAN_RUN_ID are surfaced when set
 *   and reported as unset (never crashing) when absent or partial.
 *
 * Every test uses isolated temp HOME and cwd dirs so tier resolution sees only
 * the hooks this test seeded.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan, repoRootDir } from './helpers/spawn.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Make a throwaway temp dir under the given prefix and register it for teardown.
// Tests use separate dirs for HOME (user tier) and cwd (project tier).
function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// Write a hook at `<root>/.claude/hooks/gan-confine.sh` with arbitrary content.
// `root` is a HOME dir for the user-tier hook or a cwd for the project-tier one.
function seedHook(root: string, content: string): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  return p;
}

// The framework version from package.json, used to author "current" user-tier
// hooks and to assert the command recognises them as up to date.
const CURRENT_VERSION = (
  JSON.parse(readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Build the canonical user-tier hook body for a given framework version. The
// returned string is fixture DATA: its `#`-prefixed lines are the hook's own
// banner (notably the "Source of truth: ... version <version>" line the
// command parses to detect authored-version), not comments in this test file.
function userHookHeader(version: string): string {
  return (
    '#!/bin/bash\n' +
    '# gan-confine.sh — ClaudeAgents PreToolUse confinement hook\n' +
    '# Authored by ClaudeAgents install.sh; do not edit by hand.\n' +
    `# Source of truth: ClaudeAgents framework, version ${version}.\n` +
    '# To override per-project, write a hook at <project>/.claude/hooks/gan-confine.sh.\n' +
    'exit 0\n'
  );
}

// Fixture DATA — a project-tier hook that references the retired `.gan/` path.
// The `.gan/` token inside this string is what triggers the legacy-deletion
// hint; it is hook content, not a comment.
const LEGACY_PROJECT_HOOK =
  '#!/bin/bash\n# legacy project hook\nif [[ "$path" == *.gan/* ]]; then\n  exit 0\nfi\nexit 1\n';

// Fixture DATA — a current project-tier hook using the modern `.gan-state/...`
// path. It must NOT trip the legacy hint, so it is the negative control paired
// with LEGACY_PROJECT_HOOK above.
const CURRENT_PROJECT_HOOK =
  '#!/bin/bash\n# current project hook\nWORKTREE=".gan-state/runs/$GAN_RUN_ID/worktree"\nexit 0\n';

describe('gan hooks status', () => {
  it('dispatch: `gan hooks` with no inner subcommand exits 64 with a help pointer', async () => {
    const r = await runGan(['hooks']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('gan hooks --help');
  });

  it('dispatch: `gan hooks bogus` exits 64 with an unknown-subcommand message', async () => {
    const r = await runGan(['hooks', 'bogus']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain("unknown subcommand 'gan hooks bogus'");
  });

  it('dispatch: `gan hooks status` reaches the handler (not the unknown-subcommand error)', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('User-tier framework hook:');
    expect(r.stderr).not.toContain('unknown subcommand');
  });

  it('AC-A8: user-tier present, no project-tier → reports only the user-tier hook', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('.claude/hooks/gan-confine.sh');
    expect(r.stdout).toContain(`Authored by ClaudeAgents ${CURRENT_VERSION} — current.`);
    expect(r.stdout).not.toContain('Project-tier override');
    expect(r.stdout).not.toContain('rm .claude/hooks/gan-confine.sh');
  });

  it('AC-A8 --json: project-tier reflects absence, no legacy hint', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      userTier: { present: boolean; authoredVersion: string; current: boolean };
      projectTier: { present: boolean };
      legacyDeletionHint: boolean;
    };
    expect(parsed.userTier.present).toBe(true);
    expect(parsed.userTier.authoredVersion).toBe(CURRENT_VERSION);
    expect(parsed.userTier.current).toBe(true);
    expect(parsed.projectTier.present).toBe(false);
    expect(parsed.legacyDeletionHint).toBe(false);
  });

  it('AC-A9 current: both tiers reported, precedence noted, NO deletion hint', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    seedHook(cwd, CURRENT_PROJECT_HOOK);
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Project-tier override:');
    expect(r.stdout).toContain('take precedence over the user-tier hook');
    expect(r.stdout).not.toContain('rm .claude/hooks/gan-confine.sh');
  });

  it('AC-A9 legacy: project-tier referencing .gan/ → deletion hint with rm suggestion', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    seedHook(cwd, LEGACY_PROJECT_HOOK);
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Project-tier override:');
    expect(r.stdout).toContain('`.gan/`');
    expect(r.stdout).toContain('rm .claude/hooks/gan-confine.sh');
  });

  it('AC-A9 legacy --json: legacyDeletionHint true; current project hook leaves it false', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const legacyCwd = makeTmpDir('gan-hooks-cwd-');
    const currentCwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    seedHook(legacyCwd, LEGACY_PROJECT_HOOK);
    seedHook(currentCwd, CURRENT_PROJECT_HOOK);

    const legacy = await runGan(['hooks', 'status', '--json'], {
      cwd: legacyCwd,
      extraEnv: { HOME: home },
    });
    const current = await runGan(['hooks', 'status', '--json'], {
      cwd: currentCwd,
      extraEnv: { HOME: home },
    });
    expect((JSON.parse(legacy.stdout) as { legacyDeletionHint: boolean }).legacyDeletionHint).toBe(
      true,
    );
    expect(
      (JSON.parse(current.stdout) as { legacyDeletionHint: boolean }).legacyDeletionHint,
    ).toBe(false);
  });

  it('absent user-tier: graceful not-installed report, clean exit, no stack trace', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Not installed.');
    expect(r.stdout).toContain('install.sh');
  });

  it('--json round-trip: sorted-key, two-space-indent, trailing-newline, byte-identical re-emit', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout).toContain('\n  "');
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;

    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());

    const again = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(again.stdout).toBe(r.stdout);
  });

  // Security-critical: `hooks status` must treat hook files as inert text, never
  // execute them. The bait hook contains command substitutions that would
  // `touch` a sentinel if the body were ever evaluated by a shell; the test
  // both asserts the sentinel was NOT created (no code execution) and that the
  // embedded `.gan/` token still drives the legacy hint (classification by
  // string match, not by running the file).
  it('robustness: shell-injection-bait + .gan/ token → legacy hint, no side-effect, no crash', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    // Sentinel path lives in its own temp dir; its (non-)existence is the proof
    // of whether the bait ran.
    const sentinel = path.join(makeTmpDir('gan-hooks-sentinel-'), 'pwned');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const bait =
      '#!/bin/bash\n' +
      `$(touch ${sentinel}); \`touch ${sentinel}\`; rm -rf /tmp/should-not-run\n` +
      'if [[ "$path" == *.gan/* ]]; then exit 0; fi\n';
    seedHook(cwd, bait);
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    // The load-bearing assertion: the bait's `touch` never ran.
    expect(existsSync(sentinel)).toBe(false);
    expect(r.stdout).toContain('rm .claude/hooks/gan-confine.sh');
  });

  it('robustness: large + binary/NUL content classify and continue without crash', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    seedHook(home, userHookHeader(CURRENT_VERSION));

    // 5 MiB hook body: stresses the reader/classifier against a pathologically
    // large file (with a trailing `.gan/` line so it still classifies as legacy).
    const bigCwd = makeTmpDir('gan-hooks-cwd-');
    const big = 'x'.repeat(5 * 1024 * 1024) + '\nif [[ "$p" == *.gan/* ]]; then :; fi\n';
    seedHook(bigCwd, big);
    const bigR = await runGan(['hooks', 'status'], { cwd: bigCwd, extraEnv: { HOME: home } });
    expect(bigR.exitCode).toBe(0);
    expect(bigR.stderr).toBe('');

    // Binary/NUL-byte hook body: must be read and classified as a present
    // project hook without choking on non-UTF-8 bytes. Written via a raw Buffer
    // (not seedHook) so the NUL/high bytes reach disk verbatim.
    const binCwd = makeTmpDir('gan-hooks-cwd-');
    const binDir = path.join(binCwd, '.claude', 'hooks');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      path.join(binDir, 'gan-confine.sh'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80]),
    );
    const binR = await runGan(['hooks', 'status'], { cwd: binCwd, extraEnv: { HOME: home } });
    expect(binR.exitCode).toBe(0);
    expect(binR.stderr).toBe('');
    expect(binR.stdout).toContain('Project-tier override:');
  });

  // A hook present but missing the "Source of truth: ... version" line must
  // report present=true with authoredVersion=null (unknown) rather than throwing
  // on the absent version.
  it('corrupted header: present user-tier hook with no version line → unknown, not a crash', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, '#!/bin/bash\n# no version line here\nexit 0\n');
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      userTier: { present: boolean; authoredVersion: string | null };
    };
    expect(parsed.userTier.present).toBe(true);
    expect(parsed.userTier.authoredVersion).toBe(null);
  });

  it('F7: with GAN_WORKTREE / GAN_RUN_DIR set, the human surface reports the resolved zones', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const worktree = path.join(cwd, 'my-worktree');
    const runDir = path.join(cwd, 'store', 'runs', '20240115T091500-a1b2');
    const r = await runGan(['hooks', 'status'], {
      cwd,
      extraEnv: {
        HOME: home,
        GAN_RUN_ID: '20240115T091500-a1b2',
        GAN_WORKTREE: worktree,
        GAN_RUN_DIR: runDir,
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active-run confinement zones:');
    expect(r.stdout).toContain('`GAN_WORKTREE`');
    expect(r.stdout).toContain('`GAN_RUN_DIR`');
    expect(r.stdout).toContain('20240115T091500-a1b2');
    expect(r.stdout).toContain(worktree);
    expect(r.stdout).toContain(runDir);
  });

  it('F7 --json: the zone fields surface the resolved values', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const worktree = path.join(cwd, 'my-worktree');
    const runDir = path.join(cwd, 'store', 'runs', '20240115T091500-a1b2');
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: {
        HOME: home,
        GAN_RUN_ID: '20240115T091500-a1b2',
        GAN_WORKTREE: worktree,
        GAN_RUN_DIR: runDir,
      },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      runZones: { runId: string | null; worktree: string | null; runDir: string | null };
    };
    expect(parsed.runZones.runId).toBe('20240115T091500-a1b2');
    expect(parsed.runZones.worktree).toBe(worktree);
    expect(parsed.runZones.runDir).toBe(runDir);
  });

  it('F7: invoked outside a run (zones unset) → exits 0, reports them as unset, never crashes', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));

    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Active-run confinement zones:');
    expect(r.stdout).toContain('Not in a run.');

    const j = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(j.exitCode).toBe(0);
    const parsed = JSON.parse(j.stdout) as {
      runZones: { runId: string | null; worktree: string | null; runDir: string | null };
    };
    expect(parsed.runZones.runId).toBe(null);
    expect(parsed.runZones.worktree).toBe(null);
    expect(parsed.runZones.runDir).toBe(null);
  });

  // Partial run env: GAN_RUN_ID set but the worktree/run-dir vars absent. The
  // run id is surfaced while the two unset zones report null — a partial
  // environment must degrade gracefully, not crash.
  it('F7: a run-id with the zone vars unset reports the run id but unset zones (no crash)', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home, GAN_RUN_ID: '20240115T091500-a1b2' },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      runZones: { runId: string | null; worktree: string | null; runDir: string | null };
    };
    expect(parsed.runZones.runId).toBe('20240115T091500-a1b2');
    expect(parsed.runZones.worktree).toBe(null);
    expect(parsed.runZones.runDir).toBe(null);
  });

  it('--help exits 0 with usage / examples / exit codes', async () => {
    const r = await runGan(['hooks', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('gan hooks status');
  });
});

/**
 * H1 sprint 4 — `gan hooks status` smoke coverage.
 *
 * Spawns the built CLI bin against a sandboxed $HOME and tmp project cwd so
 * the test never reads or writes the developer's real `~/.claude/`. Covers
 * the AC-A8 / AC-A9 surfaces, the absent-hook graceful path, the `--json`
 * round-trip, and the untrusted-content robustness posture. The full
 * matrix lands with sprint 5; this is the smoke + contract-critical layer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan } from './helpers/spawn.js';

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

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Seed a hook file at <root>/.claude/hooks/gan-confine.sh with `content`. */
function seedHook(root: string, content: string): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  return p;
}

const CURRENT_VERSION = '0.1.0';

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

const LEGACY_PROJECT_HOOK =
  '#!/bin/bash\n# legacy project hook\nif [[ "$path" == *.gan/* ]]; then\n  exit 0\nfi\nexit 1\n';

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
    // Top-level keys are sorted.
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
    // Idempotent re-emit through the same path.
    const again = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(again.stdout).toBe(r.stdout);
  });

  it('robustness: shell-injection-bait + .gan/ token → legacy hint, no side-effect, no crash', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    const sentinel = path.join(makeTmpDir('gan-hooks-sentinel-'), 'pwned');
    seedHook(home, userHookHeader(CURRENT_VERSION));
    const bait =
      '#!/bin/bash\n' +
      `$(touch ${sentinel}); \`touch ${sentinel}\`; rm -rf /tmp/should-not-run\n` +
      'if [[ "$path" == *.gan/* ]]; then exit 0; fi\n';
    seedHook(cwd, bait);
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(r.stdout).toContain('rm .claude/hooks/gan-confine.sh');
  });

  it('robustness: large + binary/NUL content classify and continue without crash', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    seedHook(home, userHookHeader(CURRENT_VERSION));

    // 5 MB of repeated text plus a .gan/ token.
    const bigCwd = makeTmpDir('gan-hooks-cwd-');
    const big = 'x'.repeat(5 * 1024 * 1024) + '\nif [[ "$p" == *.gan/* ]]; then :; fi\n';
    seedHook(bigCwd, big);
    const bigR = await runGan(['hooks', 'status'], { cwd: bigCwd, extraEnv: { HOME: home } });
    expect(bigR.exitCode).toBe(0);
    expect(bigR.stderr).toBe('');

    // Binary / NUL-byte content.
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

  it('--help exits 0 with usage / examples / exit codes', async () => {
    const r = await runGan(['hooks', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('gan hooks status');
  });
});

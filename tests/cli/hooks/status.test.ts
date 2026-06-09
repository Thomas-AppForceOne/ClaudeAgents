/**
 * End-to-end tests for `gan hooks status` (H3's R3 subcommand surface).
 *
 * The status command supersedes the legacy flat-path command. It reports:
 * - the user-tier hook (banner version, derived contract revision, Claude
 *   Code registration in `~/.claude/settings.json` via canonical-path
 *   equality);
 * - any project-tier hook (the same fields plus the per-tier bannerVerdict,
 *   probeVerdict, resolved verdict, and any `.gan-bak.*` backup siblings);
 * - the orphan-backup case (`projectTier === null` but backup siblings
 *   still present from a prior `migrate` run).
 *
 * Exit code is `0` when no project-tier hook is present or the probe
 * passes; `2` when the project-tier hook is `stale` or `misconfigured` so
 * a CI gate can refuse the workspace.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan, repoRootDir } from '../helpers/spawn.js';

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

function seedHook(root: string, content: string, mode = 0o755): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

const CURRENT_VERSION = (
  JSON.parse(readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Read the framework's current rendered template (version-substituted) so
// tests can stage a project-tier hook byte-identical with the template.
function renderedTemplate(): string {
  const root = repoRootDir();
  const tpl = readFileSync(
    path.join(root, 'scripts', 'hooks', 'gan-confine.sh.template'),
    'utf8',
  );
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(CURRENT_VERSION);
}

describe('gan hooks status (new subdirectory subcommand)', () => {
  it('dispatch: bare `gan hooks` exits 64 with help pointer naming both subcommands', async () => {
    const r = await runGan(['hooks']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('gan hooks --help');
    expect(r.stderr).toContain('status');
    expect(r.stderr).toContain('migrate');
  });

  it('dispatch: `gan hooks status` reaches the new subdirectory module', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('User-tier hook:');
    expect(r.stderr).not.toContain('unknown subcommand');
  });

  it('AC1: user-tier present, no project-tier → verdict current, exit 0', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      userTier: { path: string; frameworkVersion: string | null; contractRevision: string };
      projectTier: unknown;
      verdict: string;
    };
    expect(parsed.userTier.frameworkVersion).toBe(CURRENT_VERSION);
    expect(parsed.userTier.contractRevision).toBe('F7');
    expect(parsed.projectTier).toBeNull();
    expect(parsed.verdict).toBe('current');
  });

  it('AC1: project-tier carrying current template → verdict current, exit 0', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    seedHook(cwd, renderedTemplate());
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      projectTier: {
        bannerVerdict: string;
        probeVerdict: string;
        verdict: string;
        backupSiblings: string[];
      } | null;
      verdict: string;
    };
    expect(parsed.projectTier).not.toBeNull();
    expect(parsed.projectTier!.bannerVerdict).toBe('matches');
    expect(parsed.projectTier!.probeVerdict).toBe('current');
    expect(parsed.projectTier!.verdict).toBe('current');
    expect(parsed.verdict).toBe('current');
    expect(parsed.projectTier!.backupSiblings).toEqual([]);
  });

  it('AC1: project-tier pre-F7 (refuses the GAN_RUN_DIR write) → verdict stale, exit 2', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    // Pre-F7 hook: refuses every write outright. The probe's allow-listed
    // GAN_RUN_DIR write will be denied → stale.
    seedHook(cwd, '#!/bin/bash\nexit 1\n');
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout) as {
      projectTier: { verdict: string; probeVerdict: string } | null;
      verdict: string;
    };
    expect(parsed.projectTier!.verdict).toBe('stale');
    expect(parsed.projectTier!.probeVerdict).toBe('stale');
    expect(parsed.verdict).toBe('stale');
  });

  it('AC1: project-tier non-bash file → verdict misconfigured, exit 2', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    // Non-bash binary: no shebang. Probe classifies as `misconfigured`.
    const hooksDir = path.join(cwd, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      path.join(hooksDir, 'gan-confine.sh'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80]),
    );
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout) as {
      projectTier: { verdict: string; probeVerdict: string } | null;
      verdict: string;
    };
    expect(parsed.projectTier!.verdict).toBe('misconfigured');
    expect(parsed.projectTier!.probeVerdict).toBe('misconfigured');
    expect(parsed.verdict).toBe('misconfigured');
  });

  it('AC1: stale project-tier human surface includes remediation hint', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    seedHook(cwd, '#!/bin/bash\nexit 1\n');
    const r = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('gan hooks migrate --delete');
    expect(r.stdout).toContain('gan hooks migrate --review');
  });

  it('AC1: orphan-backup case surfaces under orphanBackupSiblings', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    // Plant a backup sibling without the original hook file.
    const hooksDir = path.join(cwd, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      path.join(hooksDir, 'gan-confine.sh.gan-bak.2026-06-08T19:42:11Z'),
      '#!/bin/bash\n# prior content\n',
    );
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      projectTier: unknown;
      orphanBackupSiblings?: string[];
      verdict: string;
    };
    expect(parsed.projectTier).toBeNull();
    expect(parsed.orphanBackupSiblings).toBeDefined();
    expect(parsed.orphanBackupSiblings!.length).toBe(1);
    expect(parsed.verdict).toBe('current');
  });

  it('AC1: Claude Code registration is detected via canonical-path equality on settings.json', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    // Write a settings.json carrying the user-tier hook path under
    // hooks.PreToolUse[].hooks[].command.
    const settingsDir = path.join(home, '.claude');
    const hookAbs = path.join(home, '.claude', 'hooks', 'gan-confine.sh');
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit|NotebookEdit',
              hooks: [{ type: 'command', command: hookAbs }],
            },
          ],
        },
      }),
    );
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { userTier: { registered: boolean } };
    expect(parsed.userTier.registered).toBe(true);
  });

  it('AC1: missing settings.json → registered:false (graceful)', async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    const r = await runGan(['hooks', 'status', '--json'], { cwd, extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { userTier: { registered: boolean } };
    expect(parsed.userTier.registered).toBe(false);
  });

  it('--help exits 0 with usage / examples', async () => {
    const r = await runGan(['hooks', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('gan hooks status');
    expect(r.stdout).toContain('gan hooks migrate');
  });

  // The JSON shape carries `schemaVersion: "1"` as a stable
  // discriminator so a downstream consumer (a CI gate, an audit
  // pipeline) can pin the version it parses against. Additive
  // evolution is allowed without bumping the discriminator; a
  // removal / rename / enum-tightening does bump. This test pins
  // the current discriminator value so an accidental bump surfaces
  // in CI rather than silently breaking every consumer.
  it("--json output carries schemaVersion='1'", async () => {
    const home = makeTmpDir('gan-hooks-home-');
    const cwd = makeTmpDir('gan-hooks-cwd-');
    seedHook(home, renderedTemplate());
    const r = await runGan(['hooks', 'status', '--json'], {
      cwd,
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { schemaVersion: string };
    expect(parsed.schemaVersion).toBe('1');
  });
});

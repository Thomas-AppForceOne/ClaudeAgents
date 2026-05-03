/**
 * R2 sprint 3 — `--uninstall` mode tests for `install.sh`.
 *
 * Covers S3-AC5..S3-AC7:
 *   AC5 — Uninstall removes what install added (symlinks, MCP entry);
 *         zones, `.claude/gan/`, and the once-per-machine backup are
 *         left intact; stdout has follow-up hints in backticks.
 *   AC6 — Uninstall is idempotent: running twice both exit 0 with no
 *         errors.
 *   AC7 — Uninstall against a clean HOME exits 0 with a helpful
 *         message and no errors.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeNpm, writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

interface SetupResult {
  tmp: TmpHome;
  pathOverride: string;
  cwd: string;
}

function baseSetup(): SetupResult {
  const tmp = makeTmpHome({ withRepo: true });
  cleanups.push(tmp);
  const hostNode = process.execPath;
  writeStubBin(
    tmp.bin,
    'node',
    [
      `if [ "$1" = "--version" ]; then`,
      `  printf '%s\\n' "v20.10.0"`,
      `  exit 0`,
      `fi`,
      `exec ${JSON.stringify(hostNode)} "$@"`,
    ].join('\n'),
  );
  writeStubBin(tmp.bin, 'git', `exec /usr/bin/git "$@"\n`);
  writeStubBin(tmp.bin, 'claude', 'exit 0');
  writeFakeNpm(tmp.bin, { exitCode: 0, invocationLog: npmInvocationLog(tmp.root) });
  return { tmp, pathOverride: tmp.bin, cwd: tmp.repo! };
}

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('install.sh --uninstall', () => {
  it('S3-AC5: removes what install added (symlinks, MCP entry); zones, `.claude/gan/`, backup intact; stdout has follow-up hints in backticks', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();
    const v = packageVersion();
    writeFakeConfigServer(tmp.bin, { version: v });

    // Pre-seed an existing `~/.claude.json` so the install creates a
    // backup; the uninstall must leave that backup alone.
    writeFileSync(path.join(tmp.home, '.claude.json'), '{"existing":true}\n');

    // Pre-seed a `.claude/gan/` to assert it survives uninstall.
    const projectGanDir = path.join(cwd, '.claude', 'gan');
    mkdirSync(projectGanDir, { recursive: true });
    writeFileSync(path.join(projectGanDir, 'overlay.md'), 'project overlay\n');

    // Install first.
    const r1 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);

    // Sanity: install created links and the registration entry.
    const skillLink = path.join(tmp.home, '.claude', 'skills', 'gan');
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
    const cjBefore = JSON.parse(readFileSync(path.join(tmp.home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cjBefore.mcpServers['claudeagents-config']).toBeDefined();

    // Capture the once-per-machine backup file name.
    const backupsBefore = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(backupsBefore).toHaveLength(1);

    // Sanity: zones exist before uninstall.
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(true);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(true);

    // Uninstall.
    const r2 = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).not.toMatch(/error:/);

    // Symlinks gone.
    expect(existsSync(skillLink)).toBe(false);
    const agentsDir = path.join(tmp.home, '.claude', 'agents');
    if (existsSync(agentsDir)) {
      const remaining = readdirSync(agentsDir).filter((name) => {
        try {
          const st = lstatSync(path.join(agentsDir, name));
          return st.isSymbolicLink();
        } catch {
          return false;
        }
      });
      expect(remaining).toEqual([]);
    }

    // MCP entry stripped from `~/.claude.json`; the rest of the file
    // is preserved.
    const cjAfter = JSON.parse(readFileSync(path.join(tmp.home, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      existing?: boolean;
    };
    expect(cjAfter.existing).toBe(true);
    if (cjAfter.mcpServers) {
      expect(cjAfter.mcpServers['claudeagents-config']).toBeUndefined();
    }

    // Zones, `.claude/gan/`, and the once-per-machine backup intact.
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(true);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(true);
    expect(existsSync(projectGanDir)).toBe(true);
    expect(existsSync(path.join(projectGanDir, 'overlay.md'))).toBe(true);
    const backupsAfter = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(backupsAfter).toEqual(backupsBefore);

    // Follow-up hints in backticks.
    expect(r2.stdout).toMatch(/`npm uninstall -g @claudeagents\/config-server`/);
    expect(r2.stdout).toMatch(/`rm -rf \.gan-state \.gan-cache`/);
  });

  it('S3-AC6: --uninstall is idempotent — two runs both exit 0 with no errors', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();
    const v = packageVersion();
    writeFakeConfigServer(tmp.bin, { version: v });

    // Install once to seed real artifacts.
    const r1 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);

    const u1 = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(u1.exitCode).toBe(0);
    expect(u1.stderr).not.toMatch(/error:/);

    const u2 = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(u2.exitCode).toBe(0);
    expect(u2.stderr).not.toMatch(/error:/);
  });

  it('S3-AC7: --uninstall against a clean HOME exits 0 with a helpful message', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();
    const v = packageVersion();
    writeFakeConfigServer(tmp.bin, { version: v });

    // Skip the install step entirely — uninstall must tolerate a
    // never-installed HOME.
    const result = await runInstall(['--uninstall'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/error:/);
    // The follow-up hints should still appear.
    expect(result.stdout).toMatch(/`npm uninstall -g @claudeagents\/config-server`/);
    expect(result.stdout).toMatch(/`rm -rf \.gan-state \.gan-cache`/);
  });

  it('removes builtin-stacks symlink when pointing into framework install', async () => {
    // Set up a synthetic npm root and a symlink that points into it.
    const tmp = makeTmpHome({ withRepo: true });
    cleanups.push(tmp);
    const npmRoot = path.join(tmp.root, 'npm-root');
    const fakeFrameworkStacks = path.join(npmRoot, '@claudeagents', 'config-server', 'stacks');
    mkdirSync(fakeFrameworkStacks, { recursive: true });

    // Stub `npm root -g` to print our synthetic root.
    const escapedRoot = JSON.stringify(npmRoot);
    const escapedLog = JSON.stringify(npmInvocationLog(tmp.root));
    writeStubBin(
      tmp.bin,
      'npm',
      [
        `printf '%s\\n' "$*" >> ${escapedLog}`,
        `if [ "$1" = "root" ] && [ "$2" = "-g" ]; then`,
        `  printf '%s\\n' ${escapedRoot}`,
        `  exit 0`,
        `fi`,
        `exit 0`,
      ].join('\n'),
    );

    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      [
        `if [ "$1" = "--version" ]; then`,
        `  printf '%s\\n' "v20.10.0"`,
        `  exit 0`,
        `fi`,
        `exec ${JSON.stringify(hostNode)} "$@"`,
      ].join('\n'),
    );
    writeStubBin(tmp.bin, 'git', `exec /usr/bin/git "$@"\n`);
    writeStubBin(tmp.bin, 'claude', 'exit 0');

    // Pre-seed the symlink at the canonical user-tier location.
    const linkPath = path.join(tmp.home, '.claude', 'gan', 'builtin-stacks');
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(fakeFrameworkStacks, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    const r = await runInstall(['--uninstall'], {
      home: tmp.home,
      pathOverride: tmp.bin,
      cwd: tmp.repo!,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/error:/);

    // Symlink removed.
    expect(existsSync(linkPath)).toBe(false);
  });

  it('leaves user-redirected builtin-stacks symlink alone', async () => {
    // Symlink points OUTSIDE the framework install — uninstall must not
    // remove it.
    const tmp = makeTmpHome({ withRepo: true });
    cleanups.push(tmp);
    const npmRoot = path.join(tmp.root, 'npm-root');
    mkdirSync(npmRoot, { recursive: true });

    // Stub `npm root -g` to print our synthetic root.
    const escapedRoot = JSON.stringify(npmRoot);
    const escapedLog = JSON.stringify(npmInvocationLog(tmp.root));
    writeStubBin(
      tmp.bin,
      'npm',
      [
        `printf '%s\\n' "$*" >> ${escapedLog}`,
        `if [ "$1" = "root" ] && [ "$2" = "-g" ]; then`,
        `  printf '%s\\n' ${escapedRoot}`,
        `  exit 0`,
        `fi`,
        `exit 0`,
      ].join('\n'),
    );

    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      [
        `if [ "$1" = "--version" ]; then`,
        `  printf '%s\\n' "v20.10.0"`,
        `  exit 0`,
        `fi`,
        `exec ${JSON.stringify(hostNode)} "$@"`,
      ].join('\n'),
    );
    writeStubBin(tmp.bin, 'git', `exec /usr/bin/git "$@"\n`);
    writeStubBin(tmp.bin, 'claude', 'exit 0');

    // Pre-seed the symlink pointing somewhere unrelated.
    const userTarget = path.join(tmp.root, 'my-own-stacks-dir');
    mkdirSync(userTarget, { recursive: true });
    const linkPath = path.join(tmp.home, '.claude', 'gan', 'builtin-stacks');
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(userTarget, linkPath);

    const r = await runInstall(['--uninstall'], {
      home: tmp.home,
      pathOverride: tmp.bin,
      cwd: tmp.repo!,
    });
    expect(r.exitCode).toBe(0);

    // Symlink survived intact.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(userTarget);
    // Stderr mentions the leave-alone case.
    expect(r.stderr).toMatch(/points elsewhere; leaving alone/);
  });
});


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

    writeFileSync(path.join(tmp.home, '.claude.json'), '{"existing":true}\n');

    const projectGanDir = path.join(cwd, '.claude', 'gan');
    mkdirSync(projectGanDir, { recursive: true });
    writeFileSync(path.join(projectGanDir, 'overlay.md'), 'project overlay\n');

    const r1 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);

    const skillTarget = path.join(tmp.home, '.claude', 'skills', 'gan');
    const skillStat = lstatSync(skillTarget);
    expect(skillStat.isSymbolicLink()).toBe(false);
    expect(skillStat.isDirectory()).toBe(true);
    const cjBefore = JSON.parse(readFileSync(path.join(tmp.home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cjBefore.mcpServers['claudeagents-config']).toBeDefined();

    const backupsBefore = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(backupsBefore).toHaveLength(1);

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(true);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(true);

    const r2 = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).not.toMatch(/error:/);

    expect(existsSync(skillTarget)).toBe(false);

    const agentsDir = path.join(tmp.home, '.claude', 'agents');
    if (existsSync(agentsDir)) {
      const remaining = readdirSync(agentsDir).filter((name) => name.startsWith('gan-'));
      expect(remaining).toEqual([]);
    }

    const cjAfter = JSON.parse(readFileSync(path.join(tmp.home, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      existing?: boolean;
    };
    expect(cjAfter.existing).toBe(true);
    if (cjAfter.mcpServers) {
      expect(cjAfter.mcpServers['claudeagents-config']).toBeUndefined();
    }

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(true);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(true);
    expect(existsSync(projectGanDir)).toBe(true);
    expect(existsSync(path.join(projectGanDir, 'overlay.md'))).toBe(true);
    const backupsAfter = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(backupsAfter).toEqual(backupsBefore);

    expect(r2.stdout).toMatch(/`rm -rf \.gan-state \.gan-cache`/);
  });

  it('S3-AC6: --uninstall is idempotent — two runs both exit 0 with no errors', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();
    const v = packageVersion();
    writeFakeConfigServer(tmp.bin, { version: v });

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

    const result = await runInstall(['--uninstall'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/error:/);

    expect(result.stdout).toMatch(/`rm -rf \.gan-state \.gan-cache`/);
  });

  it('removes builtin-stacks symlink when pointing into framework install', async () => {

    const tmp = makeTmpHome({ withRepo: true });
    cleanups.push(tmp);
    const npmRoot = path.join(tmp.root, 'npm-root');
    const fakeFrameworkStacks = path.join(npmRoot, '@claudeagents', 'config-server', 'stacks');
    mkdirSync(fakeFrameworkStacks, { recursive: true });

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

    expect(existsSync(linkPath)).toBe(false);
  });

  it('leaves user-redirected builtin-stacks symlink alone', async () => {

    const tmp = makeTmpHome({ withRepo: true });
    cleanups.push(tmp);
    const npmRoot = path.join(tmp.root, 'npm-root');
    mkdirSync(npmRoot, { recursive: true });

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

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(userTarget);

    expect(r.stderr).toMatch(/points elsewhere; leaving alone/);
  });
});

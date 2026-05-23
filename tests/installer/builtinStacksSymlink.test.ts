
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';

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

  npmRoot: string;

  linkPath: string;

  expectedTarget: string;
}

function writeFakeNpmWithRoot(
  bin: string,
  invocationLog: string,
  npmRoot: string,
  options: { rootFails?: boolean; rootValue?: string } = {},
): void {
  const escapedLog = JSON.stringify(invocationLog);
  const rootValue = options.rootValue ?? npmRoot;
  const escapedRoot = JSON.stringify(rootValue);
  const lines: string[] = [
    `printf '%s\\n' "$*" >> ${escapedLog}`,
    `if [ "$1" = "root" ] && [ "$2" = "-g" ]; then`,
  ];
  if (options.rootFails) {
    lines.push(`  exit 1`);
  } else {
    lines.push(`  printf '%s\\n' ${escapedRoot}`);
    lines.push(`  exit 0`);
  }
  lines.push(`fi`);
  lines.push(`exit 0`);
  writeStubBin(bin, 'npm', lines.join('\n'));
}

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
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

  const npmRoot = path.join(tmp.root, 'npm-root');
  mkdirSync(npmRoot, { recursive: true });

  writeFakeNpmWithRoot(tmp.bin, npmInvocationLog(tmp.root), npmRoot);

  writeFakeConfigServer(tmp.bin, { version: packageVersion() });

  const linkPath = path.join(tmp.home, '.claude', 'gan', 'builtin-stacks');
  const expectedTarget = path.join(npmRoot, '@claudeagents', 'config-server', 'stacks');

  return {
    tmp,
    pathOverride: tmp.bin,
    cwd: tmp.repo!,
    npmRoot,
    linkPath,
    expectedTarget,
  };
}

function seedBuiltinStacks(npmRoot: string): string {
  const dir = path.join(npmRoot, '@claudeagents', 'config-server', 'stacks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'web-node.md'), '# fake builtin stack\n');
  return dir;
}

describe('install.sh — built-in stacks symlink', () => {
  it('happy path: creates $HOME/.claude/gan/builtin-stacks pointing at <packageRoot>/stacks', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    const r = await runInstall([], { home: s.tmp.home, pathOverride: s.pathOverride, cwd: s.cwd });
    expect(r.exitCode).toBe(0);

    expect(lstatSync(s.linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.linkPath)).toBe(s.expectedTarget);
  });

  it('idempotent: a second install run leaves the same symlink in place with no errors', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    const r1 = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r1.exitCode).toBe(0);
    expect(readlinkSync(s.linkPath)).toBe(s.expectedTarget);

    const r2 = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).not.toMatch(/error:/);
    expect(lstatSync(s.linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.linkPath)).toBe(s.expectedTarget);
  });

  it('replaces a stale symlink that points at a different path', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    mkdirSync(path.dirname(s.linkPath), { recursive: true });
    const stale = path.join(s.tmp.root, 'stale-target');
    mkdirSync(stale, { recursive: true });
    symlinkSync(stale, s.linkPath);
    expect(readlinkSync(s.linkPath)).toBe(stale);

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    expect(lstatSync(s.linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.linkPath)).toBe(s.expectedTarget);
  });

  it('refuses to clobber a real directory at the symlink path', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    mkdirSync(s.linkPath, { recursive: true });
    const sentinel = path.join(s.linkPath, 'user-file');
    writeFileSync(sentinel, 'do not delete\n');

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    const st = lstatSync(s.linkPath);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(existsSync(sentinel)).toBe(true);

    expect(r.stderr).toMatch(/warning:/);
  });

  it('refuses to clobber a real file at the symlink path', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    mkdirSync(path.dirname(s.linkPath), { recursive: true });
    writeFileSync(s.linkPath, 'sentinel\n');

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    const st = lstatSync(s.linkPath);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(readFileSync(s.linkPath, 'utf8')).toBe('sentinel\n');
    expect(r.stderr).toMatch(/warning:/);
  });

  it('npm root -g failure: install warns, no symlink, exits 0', async () => {
    const s = baseSetup();

    writeFakeNpmWithRoot(s.tmp.bin, npmInvocationLog(s.tmp.root), s.npmRoot, { rootFails: true });

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    expect(existsSync(s.linkPath)).toBe(false);
    expect(r.stderr).toMatch(/warning:/);
    expect(r.stderr).toMatch(/npm global root/);
  });

  it('missing packageRoot stacks dir: install warns, no symlink, exits 0', async () => {
    const s = baseSetup();

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    expect(existsSync(s.linkPath)).toBe(false);
    expect(r.stderr).toMatch(/warning:/);
    expect(r.stderr).toMatch(/Built-in stacks directory not found/);
  });

  it('Windows skip: install exits 0 with no symlink and no error', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    writeStubBin(s.tmp.bin, 'uname', `printf '%s\\n' "MINGW64_NT-10.0"\nexit 0\n`);

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/error:/);
    expect(existsSync(s.linkPath)).toBe(false);
  });

  it('final-status line: post-install stdout names the built-in stacks symlink when created', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/built-in stacks|builtin-stacks/);
  });
});

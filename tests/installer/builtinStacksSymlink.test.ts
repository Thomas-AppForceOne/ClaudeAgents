/**
 * Post-R audit Sprint 7 — built-in stacks symlink tests for `install.sh`.
 *
 * Covers the contract for `create_builtin_stacks_symlink()`:
 *   - Happy path: clean install creates `$HOME/.claude/gan/builtin-stacks`
 *     as a symlink pointing at `<npm root -g>/@claudeagents/config-server/stacks`.
 *   - Idempotency: a second install produces the same symlink, no errors.
 *   - Replaces stale: a pre-seeded symlink to a different path is replaced.
 *   - Refuses real directory: a real dir at the path is left intact.
 *   - Refuses real file: a regular file at the path is left intact.
 *   - `npm root -g` failure: install logs warning, exits 0, no symlink.
 *   - Missing packageRoot/stacks: install logs warning, exits 0, no symlink.
 *   - Windows skip: stub `uname` to print `MINGW64_NT-10.0` → no symlink, exit 0.
 *   - Final-status line: post-install stdout contains `built-in stacks` or
 *     `builtin-stacks` when the symlink was created.
 */
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
  /**
   * Absolute path the fake `npm root -g` prints. Tests use this to seed
   * (or not) a `<npm_root>/@claudeagents/config-server/stacks/` directory
   * to exercise the various symlink-creation paths.
   */
  npmRoot: string;
  /** The expected symlink path. */
  linkPath: string;
  /** The expected symlink target. */
  expectedTarget: string;
}

/**
 * Writes a fake `npm` that:
 *  - exits 0 on `install`-flavoured invocations and records them to
 *    `npmInvocationLog`;
 *  - prints `npmRoot` on `npm root -g`.
 *
 * If `rootFails` is true, `npm root -g` exits 1 with no output.
 * If `rootValue` is supplied, that value is printed instead of `npmRoot`.
 */
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

  // Make the version-probe match so npm install is skipped — we want the
  // happy path to flow through to the symlink step regardless.
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

/** Seed `<npmRoot>/@claudeagents/config-server/stacks/` with a marker file. */
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

    // Pre-seed a stale symlink that points somewhere else.
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

    // Pre-seed a real directory at the would-be symlink path.
    mkdirSync(s.linkPath, { recursive: true });
    const sentinel = path.join(s.linkPath, 'user-file');
    writeFileSync(sentinel, 'do not delete\n');

    const r = await runInstall([], {
      home: s.tmp.home,
      pathOverride: s.pathOverride,
      cwd: s.cwd,
    });
    expect(r.exitCode).toBe(0);

    // Real directory survives intact (not converted to a symlink).
    const st = lstatSync(s.linkPath);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
    // The installer warned rather than aborting.
    expect(r.stderr).toMatch(/warning:/);
  });

  it('refuses to clobber a real file at the symlink path', async () => {
    const s = baseSetup();
    seedBuiltinStacks(s.npmRoot);

    // Pre-seed a real file at the would-be symlink path.
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
    // Re-stub npm so `npm root -g` fails.
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
    // Do NOT seed `<npmRoot>/@claudeagents/config-server/stacks/`.

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

    // Stub `uname` so the Windows-shell case branch fires.
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

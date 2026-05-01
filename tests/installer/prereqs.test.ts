/**
 * R2 sprint 1 — prerequisite-check tests for `install.sh`.
 *
 * Each test builds a fresh stub-bin populated with controlled stubs for
 * `node`, `git`, and `claude`, then invokes `install.sh` with PATH set to
 * `<stubBin>:/bin` so coreutils (`cat`) still resolve while the prereq
 * tools are exclusively the test fixtures.
 *
 * Covers contract F-AC4..F-AC8 plus H1 (no filesystem writes against an
 * empty tmp HOME).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { runInstall } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

interface StubSpec {
  /** If undefined, no `node` stub is created (= "not on PATH"). */
  nodeVersion?: string;
  /** If true, a `git` stub is created. */
  withGit?: boolean;
  /** If true, a `claude` stub is created. */
  withClaude?: boolean;
}

function setup(stubs: StubSpec): { tmp: TmpHome; pathOverride: string } {
  const tmp = makeTmpHome();
  cleanups.push(tmp);

  if (stubs.nodeVersion !== undefined) {
    const v = stubs.nodeVersion;
    writeStubBin(
      tmp.bin,
      'node',
      `if [ "$1" = "--version" ]; then\n  echo "${v}"\n  exit 0\nfi\n# Pass-through for \`node -p\` etc. — emit empty stdout, exit 0.\nexit 0\n`,
    );
  }
  if (stubs.withGit) {
    writeStubBin(tmp.bin, 'git', 'echo "git stub"; exit 0');
  }
  if (stubs.withClaude) {
    writeStubBin(tmp.bin, 'claude', 'echo "claude stub"; exit 0');
  }

  // PATH: stub bin only. `makeTmpHome` symlinks safe system utilities
  // (`dirname`, `cat`, …) into the stub bin so `install.sh` can run, but
  // `node` / `git` / `claude` are exclusively the stubs the test sets up.
  // Excluding `/usr/bin` means the system `git` on macOS is not visible.
  const pathOverride = tmp.bin;
  return { tmp, pathOverride };
}

function homeIsEmpty(home: string): boolean {
  return readdirSync(home).length === 0;
}

describe('install.sh prerequisite checks', () => {
  it('F-AC4: rejects Node 20.9.0 with a stderr error naming Node and 20.10', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.9.0',
      withGit: true,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Node');
    expect(result.stderr).toContain('20.10');
  });

  it('F-AC8: rejects Node 23.0.0 with a stderr error naming Node and the supported range', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v23.0.0',
      withGit: true,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Node');
    // Either the lower bound or the upper bound must appear so the user
    // can reason about the supported range.
    const namesRange = result.stderr.includes('20.10') || result.stderr.includes('22');
    expect(namesRange).toBe(true);
  });

  it('F-AC5: rejects when git is missing with a stderr error naming git', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: false,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('git');
  });

  it('F-AC6: rejects when claude is missing with a stderr error naming Claude Code', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
      withClaude: false,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Claude Code');
  });

  it('F-AC7: --no-claude-code skips the Claude Code prerequisite and the install path exits 0', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
      withClaude: false,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    // S1 is skeleton-only: no filesystem mutation in the install path.
    expect(homeIsEmpty(tmp.home)).toBe(true);
  });

  it('Node 20.10.0 passes the prerequisite range check (skeleton install path)', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).toBe(0);
  });

  it('Node 22.x (Node 22 LTS) passes the prerequisite range check', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v22.4.1',
      withGit: true,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).toBe(0);
  });

  it('H1: --help against an empty tmp HOME makes zero filesystem writes', async () => {
    const { tmp, pathOverride } = setup({});
    const result = await runInstall(['--help'], { home: tmp.home, pathOverride });
    expect(result.exitCode).toBe(0);
    // The HOME directory must remain pristine.
    expect(homeIsEmpty(tmp.home)).toBe(true);
    // And no sibling files in the tmp root other than the bin and home dirs.
    const siblings = readdirSync(tmp.root).sort();
    expect(siblings).toEqual(['bin', 'home']);
  });

  it('H1: --no-claude-code against an empty tmp HOME makes zero filesystem writes', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);
    expect(homeIsEmpty(tmp.home)).toBe(true);
    const siblings = readdirSync(tmp.root).sort();
    expect(siblings).toEqual(['bin', 'home']);
    // Defense-in-depth: no `~/.claude.json` or `~/.claude/` was created.
    expect(() => readdirSync(path.join(tmp.home, '.claude'))).toThrow();
  });
});

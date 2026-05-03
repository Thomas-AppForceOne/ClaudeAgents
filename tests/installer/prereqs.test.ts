/**
 * R2 sprint 1 — prerequisite-check tests for `install.sh`.
 *
 * Each test builds a fresh stub-bin populated with controlled stubs for
 * `node`, `git`, and `claude`, then invokes `install.sh` with PATH set to
 * `<stubBin>:/bin` so coreutils (`cat`) still resolve while the prereq
 * tools are exclusively the test fixtures.
 *
 * Covers contract F-AC4..F-AC8 plus H1 on `--help`. Note that S2 turned
 * the install path from a no-op skeleton into real filesystem work, so
 * the original "no FS writes from --no-claude-code" promise no longer
 * holds for the install path — H1 only protects `--help` now (see
 * `help.test.ts` for the remaining H1 coverage).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
void _here;

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
  /**
   * If true, also writes stubs for `npm` and `claudeagents-config-server`
   * so the S2 install path can complete on a Node-prereq-pass run.
   */
  withInstallStubs?: boolean;
}

function setup(stubs: StubSpec): { tmp: TmpHome; pathOverride: string } {
  const tmp = makeTmpHome();
  cleanups.push(tmp);

  if (stubs.nodeVersion !== undefined) {
    const v = stubs.nodeVersion;
    // Resolve the host `node` once at setup time so the stub can shell
    // through to it for `node -p` / `node -e` calls (the install path
    // depends on JSON manipulation via real Node). The PATH override
    // means `install.sh` itself sees only the stubs, but the stub
    // delegates to the absolute host path internally.
    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      `if [ "$1" = "--version" ]; then\n  echo "${v}"\n  exit 0\nfi\nexec ${JSON.stringify(hostNode)} "$@"\n`,
    );
  }
  if (stubs.withGit) {
    // Forward to the real `/usr/bin/git` so subcommands the install path
    // exercises (e.g. `git rev-parse --show-toplevel`) behave correctly.
    // A naive `echo "git stub"; exit 0` makes every git call print
    // "git stub" and exit 0, so `prepare_zones` would then create
    // `git stub/.gan-state/` relative to cwd. Forwarding keeps prereq
    // checks satisfied (`command -v git` only inspects the executable)
    // while ensuring `rev-parse --show-toplevel` fails with no stdout
    // when there is no enclosing repo, so the install path's zone
    // preparation is correctly skipped.
    writeStubBin(tmp.bin, 'git', 'exec /usr/bin/git "$@"\n');
  }
  if (stubs.withClaude) {
    writeStubBin(tmp.bin, 'claude', 'exit 0');
  }
  if (stubs.withInstallStubs) {
    // Fake `npm` succeeds silently. Fake `claudeagents-config-server`
    // reports the package.json version so the version-probe matches
    // and the installer skips the `npm install -g .` invocation.
    const pkgPath = path.join(repoRootDir(), 'package.json');
    writeStubBin(tmp.bin, 'npm', 'exit 0');
    writeStubBin(
      tmp.bin,
      'claudeagents-config-server',
      `if [ "$1" = "--version" ]; then\n  ${JSON.stringify(process.execPath)} -p 'require(${JSON.stringify(pkgPath)}).version'\n  exit 0\nfi\nexit 0\n`,
    );
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
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);
    // Under --no-claude-code the JSON registration is skipped entirely.
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(false);
  });

  it('Node 20.10.0 passes the prerequisite range check (S2 install path)', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
      withClaude: true,
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);
  });

  it('Node 22.x (Node 22 LTS) passes the prerequisite range check', async () => {
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v22.4.1',
      withGit: true,
      withClaude: true,
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
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

  it('--no-claude-code against an empty tmp HOME does not write `~/.claude.json`', async () => {
    // S2 note: the install path now writes plenty (symlinks, zones).
    // This test asserts the narrower S2 invariant — under --no-claude-code,
    // the JSON registration is the only path that touches `~/.claude.json`,
    // and it is skipped.
    const { tmp, pathOverride } = setup({
      nodeVersion: 'v20.10.0',
      withGit: true,
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(false);
  });
});

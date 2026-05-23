/**
 * Coverage for install.sh's prerequisite checks (Node version floor + ceiling,
 * git present, Claude Code present) and the few flags that bypass them.
 *
 * What this verifies:
 * - F-AC4: Node below the 20.10 floor is rejected with a stderr error naming
 *   Node and the floor.
 * - I3 slice 2: a Node major ABOVE the tested-through ceiling only WARNS (and
 *   the install proceeds, including JSON registration); Node exactly at the
 *   ceiling does not warn; a missing-node error does not mention any ceiling.
 * - F-AC5/AC6: missing git / missing Claude Code each abort with a naming error.
 * - F-AC7 + --no-claude-code: skipping the Claude Code prerequisite still
 *   completes and does NOT write `~/.claude.json`.
 * - 20.10.0 and 22.x (LTS) pass the range check.
 * - H1: `--help` against an empty HOME makes ZERO filesystem writes (home stays
 *   empty, only the pre-created bin/ + home/ siblings exist).
 *
 * What it guards (WHY): prerequisite handling must fail-closed on too-old
 * Node / missing tools but warn-not-die on too-new Node (so a future runtime
 * doesn't lock users out), and read-only invocations like `--help` must never
 * touch the disk. Each test stubs only the tools it needs via the StubSpec, so
 * the absence of a tool is itself the condition under test.
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

// Declares which prerequisite tools to stub for a given test. Omitting a field
// leaves that tool OFF PATH, which is how the "missing X" cases are produced:
// - nodeVersion: if set, stub `node --version` to report it (else node absent);
// - withGit / withClaude: place a passing stub for that tool;
// - withInstallStubs: also stub npm + config-server so the full install path
//   can run to completion past the prerequisite gate.
interface StubSpec {

  nodeVersion?: string;

  withGit?: boolean;

  withClaude?: boolean;

  withInstallStubs?: boolean;
}

function setup(stubs: StubSpec): { tmp: TmpHome; pathOverride: string } {
  const tmp = makeTmpHome();
  cleanups.push(tmp);

  if (stubs.nodeVersion !== undefined) {
    const v = stubs.nodeVersion;

    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      `if [ "$1" = "--version" ]; then\n  echo "${v}"\n  exit 0\nfi\nexec ${JSON.stringify(hostNode)} "$@"\n`,
    );
  }
  if (stubs.withGit) {

    writeStubBin(tmp.bin, 'git', 'exec /usr/bin/git "$@"\n');
  }
  if (stubs.withClaude) {
    writeStubBin(tmp.bin, 'claude', 'exit 0');
  }
  if (stubs.withInstallStubs) {

    const pkgPath = path.join(repoRootDir(), 'package.json');
    writeStubBin(tmp.bin, 'npm', 'exit 0');
    writeStubBin(
      tmp.bin,
      'claudeagents-config-server',
      `if [ "$1" = "--version" ]; then\n  ${JSON.stringify(process.execPath)} -p 'require(${JSON.stringify(pkgPath)}).version'\n  exit 0\nfi\nexit 0\n`,
    );
  }

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

  it('I3 slice 2: a Node major above the tested-through ceiling warns on stderr and the install proceeds', async () => {

    const { tmp, pathOverride } = setup({
      nodeVersion: 'v99.0.0',
      withGit: true,
      withClaude: true,
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);

    expect(result.stderr).toContain('warning:');

    expect(result.stderr).toContain('99.0.0');
    expect(result.stderr).toContain('newer than');
    expect(result.stderr).toContain('tested through');
    expect(result.stderr).toContain('install will continue');

    expect(result.stderr).toContain('github.com');
  });

  it('I3 slice 2: Node at the tested-through ceiling passes without firing the warning', async () => {

    const { tmp, pathOverride } = setup({
      nodeVersion: 'v25.6.1',
      withGit: true,
      withClaude: true,
      withInstallStubs: true,
    });
    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
    });
    expect(result.exitCode).toBe(0);

    expect(result.stderr).not.toContain('tested through');
    expect(result.stderr).not.toContain('newer than');
  });

  it('I3 slice 2: warn-not-die does not break the full install path with JSON registration', async () => {

    const { tmp, pathOverride } = setup({
      nodeVersion: 'v99.0.0',
      withGit: true,
      withClaude: true,
      withInstallStubs: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('tested through');
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(true);
  });

  it('I3 slice 2: missing-`node` error does not reference an upper-bound ceiling', async () => {

    const { tmp, pathOverride } = setup({

      withGit: true,
      withClaude: true,
    });
    const result = await runInstall([], { home: tmp.home, pathOverride });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Node is not on PATH');
    expect(result.stderr).not.toContain('<=');
    expect(result.stderr).not.toContain('Node <=');
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

    expect(homeIsEmpty(tmp.home)).toBe(true);

    // Beyond an empty home, assert nothing else materialised under the temp
    // root either: only the `bin/` and `home/` that makeTmpHome pre-created.
    const siblings = readdirSync(tmp.root).sort();
    expect(siblings).toEqual(['bin', 'home']);
  });

  it('--no-claude-code against an empty tmp HOME does not write `~/.claude.json`', async () => {

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

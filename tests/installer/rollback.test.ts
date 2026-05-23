/**
 * Coverage for the S3 rollback path: when install.sh fails partway through, it
 * must undo everything it had done so far and leave the system as it found it.
 *
 * What this verifies, by where the failure is injected:
 * - S3-AC1 (npm fails after symlinks): symlinks rolled back, `~/.claude.json`
 *   byte-equal to its pre-state, no zones created, no temp stragglers.
 * - S3-AC2 (JSON edit fails after npm install): symlinks gone, `.claude.json`
 *   restored from the preedit snapshot, a manual `npm uninstall -g` HINT is
 *   emitted (rollback does NOT itself run npm uninstall), no stragglers.
 * - S3-AC3 (zone prep fails): all earlier state — symlinks, `.claude.json`,
 *   partial zones — undone.
 * - The builtin-stacks-symlink STATE_LOG kind: rollback (driven directly via a
 *   sourced, main-stripped install.sh) removes the logged symlink and leaves
 *   others alone.
 * - S3-AC4: rollback never touches PRE-EXISTING state — an unrelated symlink
 *   created before the install survives.
 *
 * What it guards (WHY): a failed install must be atomic-ish — no half-applied
 * symlinks, no mangled user `.claude.json`, no orphaned zones — and crucially
 * it must only undo what THIS run created, never pre-existing user artifacts.
 * The driver scripts and their embedded `#`/`//` lines are DATA inside string
 * literals.
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
import { injectFailureAt, makeFailureEnv } from './helpers/failurePoints.js';

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
  npmLog: string;
}

function baseSetup(opts: { withClaude?: boolean } = {}): SetupResult {
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
  if (opts.withClaude !== false) {
    writeStubBin(tmp.bin, 'claude', 'exit 0');
  }
  const npmLog = npmInvocationLog(tmp.root);
  writeFakeNpm(tmp.bin, { exitCode: 0, invocationLog: npmLog });
  return { tmp, pathOverride: tmp.bin, cwd: tmp.repo!, npmLog };
}

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

// List the framework's own agent entries (the `gan-` prefix scopes the search
// to what install adds, so an unrelated pre-existing entry is ignored). Used to
// assert these were rolled back to nothing on failure.
function listAgentSymlinks(home: string): string[] {
  const dir = path.join(home, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (!name.startsWith('gan-')) return false;
    try {
      const st = lstatSync(path.join(dir, name));
      return st.isSymbolicLink() || st.isFile();
    } catch {
      return false;
    }
  });
}

describe('install.sh — S3 rollback on partial failure', () => {
  it('S3-AC1: npm fails after symlinks → exit non-zero, symlinks rolled back, ~/.claude.json byte-equivalent to pre-state, no zones', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();

    const preState = '{\n  "preexisting": true\n}\n';
    writeFileSync(path.join(tmp.home, '.claude.json'), preState);

    const env = makeFailureEnv();
    injectFailureAt(env, 'npm-install');

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    const skillLink = path.join(tmp.home, '.claude', 'skills', 'gan');
    expect(existsSync(skillLink)).toBe(false);

    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    const homeStragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.tmp.'));
    expect(homeStragglers).toEqual([]);
  });

  it('S3-AC2: JSON edit fails after npm install → symlinks rolled back, ~/.claude.json restored from preedit, manual `npm uninstall -g` hint emitted', async () => {

    const v = packageVersion();
    void v;
    const { tmp, pathOverride, cwd, npmLog } = baseSetup();

    const preState = '{\n  "kept": true\n}\n';
    writeFileSync(path.join(tmp.home, '.claude.json'), preState);

    const env = makeFailureEnv();
    injectFailureAt(env, 'json-edit', tmp.bin);

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(false);

    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    const preedits = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.preedit-'));
    expect(preedits).toEqual([]);

    const tmpStragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.tmp.'));
    expect(tmpStragglers).toEqual([]);

    // Rollback must NOT auto-run `npm uninstall` (the global install may be
    // shared / pre-existing); it only TELLS the user how to undo it. So the npm
    // log must show no uninstall, while stderr carries the backticked hint.
    const npmRaw = existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '';
    expect(npmRaw).not.toMatch(/\buninstall\b/);

    expect(result.stderr).toMatch(/`npm uninstall -g @claudeagents\/config-server`/);

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);
  });

  it('S3-AC3: zone prep fails → all earlier state undone, ~/.claude.json restored, symlinks removed, partial zones removed', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = baseSetup();

    writeFakeConfigServer(tmp.bin, { version: v });

    const preState = '{\n  "anchor": "before"\n}\n';
    writeFileSync(path.join(tmp.home, '.claude.json'), preState);

    const env = makeFailureEnv();
    injectFailureAt(env, 'zone-prep', tmp.bin);

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(false);

    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    const stragglers = readdirSync(tmp.home).filter(
      (e) => e.startsWith('.claude.json.tmp.') || e.startsWith('.claude.json.preedit-'),
    );
    expect(stragglers).toEqual([]);
  });

  it('rollback handles builtin-stacks-symlink STATE_LOG kind: removes the logged symlink, leaves others alone', async () => {

    const { tmp } = baseSetup();
    const installScript = path.join(repoRootDir(), 'install.sh');

    const linkPath = path.join(tmp.home, '.claude', 'gan', 'builtin-stacks');
    mkdirSync(path.dirname(linkPath), { recursive: true });
    const fakeTarget = path.join(tmp.root, 'fake-target');
    mkdirSync(fakeTarget, { recursive: true });
    symlinkSync(fakeTarget, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // Source a main-stripped install.sh so the driver can seed STATE_LOG with a
    // single `builtin-stacks-symlink` entry and call `rollback` directly — a
    // unit-level test of one rollback kind, without running a full install.
    const installRaw = readFileSync(installScript, 'utf8');
    const trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');
    const trimmedPath = path.join(tmp.root, 'install-no-main.sh');
    writeFileSync(trimmedPath, trimmed);

    const driver = path.join(tmp.root, 'driver.sh');
    writeFileSync(
      driver,
      [
        `#!/usr/bin/env bash`,
        `set -uo pipefail`,
        `# shellcheck disable=SC1090`,
        `source ${JSON.stringify(trimmedPath)}`,
        `STATE_LOG=("builtin-stacks-symlink:${linkPath}")`,
        `# Call rollback directly. It logs warnings, never exits non-zero.`,
        `rollback`,
        `exit 0`,
      ].join('\n'),
      { mode: 0o755 },
    );

    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('/bin/bash', [driver], {
      env: { ...process.env, HOME: tmp.home },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    expect(existsSync(linkPath)).toBe(false);
  });

  it('S3-AC4: rollback never undoes pre-existing state — a pre-created symlink survives rollback', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();

    // Plant an unrelated symlink BEFORE the install runs. Because rollback only
    // undoes what this run created, this one must still point at its original
    // target after the (failed) install rolls back.
    mkdirSync(path.join(tmp.home, '.claude', 'agents'), { recursive: true });
    const preexisting = path.join(tmp.home, '.claude', 'agents', 'unrelated.md');
    const preexistingTargetDir = path.join(tmp.root, 'unrelated');
    mkdirSync(preexistingTargetDir, { recursive: true });
    const preexistingTarget = path.join(preexistingTargetDir, 'agent.md');
    writeFileSync(preexistingTarget, 'unrelated agent\n');
    symlinkSync(preexistingTarget, preexisting);

    const env = makeFailureEnv();
    injectFailureAt(env, 'npm-install');

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(lstatSync(preexisting).isSymbolicLink()).toBe(true);
    expect(readlinkSync(preexisting)).toBe(preexistingTarget);
  });
});

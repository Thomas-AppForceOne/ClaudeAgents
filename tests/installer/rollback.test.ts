/**
 * R2 sprint 3 — rollback tests for `install.sh`.
 *
 * Covers S3-AC1..S3-AC4:
 *   AC1 — npm fails after symlinks → exit non-zero; symlinks rolled
 *         back; ~/.claude.json byte-equivalent to pre-state; no zones.
 *   AC2 — JSON edit fails after npm install → symlinks rolled back;
 *         ~/.claude.json restored from preedit; npm package NOT
 *         uninstalled (rollback log mentions the manual command).
 *   AC3 — zone prep fails → all earlier state undone; ~/.claude.json
 *         restored; symlinks removed; partial zones removed.
 *   AC4 — Rollback never undoes pre-existing state: a symlink that
 *         existed before the run is still present after rollback.
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

function listAgentSymlinks(home: string): string[] {
  const dir = path.join(home, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return lstatSync(path.join(dir, name)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

describe('install.sh — S3 rollback on partial failure', () => {
  it('S3-AC1: npm fails after symlinks → exit non-zero, symlinks rolled back, ~/.claude.json byte-equivalent to pre-state, no zones', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();
    // Pre-seed `~/.claude.json` with a known byte-state so we can
    // assert byte-equivalence after rollback. (The version-probe is
    // missing — no fake config-server stub — so install_mcp_server is
    // entered, which is where the failure fires.)
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

    // Symlinks rolled back: `~/.claude/agents/` is empty (or the dir
    // does not even exist). The dir itself may remain — symlinks-only
    // is what we assert.
    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    const skillLink = path.join(tmp.home, '.claude', 'skills', 'gan');
    expect(existsSync(skillLink)).toBe(false);

    // ~/.claude.json byte-equivalent to pre-state. (npm failed before
    // register_mcp_in_claude_json was reached, so no edit happened —
    // but the assertion is still byte-equivalence per the contract.)
    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    // No zones inside the repo.
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    // No `.tmp.*` leftovers.
    const homeStragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.tmp.'));
    expect(homeStragglers).toEqual([]);
  });

  it('S3-AC2: JSON edit fails after npm install → symlinks rolled back, ~/.claude.json restored from preedit, manual `npm uninstall -g` hint emitted', async () => {
    // Force `install_mcp_server` to actually run by NOT writing a
    // config-server stub (version-probe is empty → mismatch → install).
    const v = packageVersion();
    void v;
    const { tmp, pathOverride, cwd, npmLog } = baseSetup();

    // Pre-seed `~/.claude.json` with a known byte-state.
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

    // Symlinks rolled back.
    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(false);

    // ~/.claude.json restored to pre-state from the preedit copy.
    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    // No preedit copy left on disk.
    const preedits = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.preedit-'));
    expect(preedits).toEqual([]);

    // No `.tmp.*` leftovers.
    const tmpStragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.tmp.'));
    expect(tmpStragglers).toEqual([]);

    // npm package NOT uninstalled (we never invoke `npm uninstall`).
    const npmRaw = existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '';
    expect(npmRaw).not.toMatch(/\buninstall\b/);

    // Rollback log mentions the manual `npm uninstall -g` command in
    // backticks (per F4: shell remediation, not Node remediation).
    expect(result.stderr).toMatch(/`npm uninstall -g @claudeagents\/config-server`/);

    // No zones (zone prep happens after register_mcp; we failed earlier).
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);
  });

  it('S3-AC3: zone prep fails → all earlier state undone, ~/.claude.json restored, symlinks removed, partial zones removed', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = baseSetup();
    // Make the version-probe match so npm install is skipped.
    writeFakeConfigServer(tmp.bin, { version: v });

    // Pre-seed `~/.claude.json` so register_mcp_in_claude_json takes
    // the preedit-copy path.
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

    // Symlinks removed.
    expect(listAgentSymlinks(tmp.home)).toEqual([]);
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(false);

    // ~/.claude.json restored from preedit (byte-equivalent).
    const postRaw = readFileSync(path.join(tmp.home, '.claude.json'), 'utf8');
    expect(postRaw).toBe(preState);

    // Partial zones removed (any that were created before the failure).
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    // No tmp / preedit leftovers.
    const stragglers = readdirSync(tmp.home).filter(
      (e) => e.startsWith('.claude.json.tmp.') || e.startsWith('.claude.json.preedit-'),
    );
    expect(stragglers).toEqual([]);
  });

  it('S3-AC4: rollback never undoes pre-existing state — a pre-created symlink survives rollback', async () => {
    const { tmp, pathOverride, cwd } = baseSetup();

    // Pre-create a symlink the installer would NOT create — its target
    // does not start with `$REPO_ROOT/agents/`. The contract says
    // rollback only removes entries it logged; pre-existing entries
    // are never touched.
    mkdirSync(path.join(tmp.home, '.claude', 'agents'), { recursive: true });
    const preexisting = path.join(tmp.home, '.claude', 'agents', 'unrelated.md');
    const preexistingTargetDir = path.join(tmp.root, 'unrelated');
    mkdirSync(preexistingTargetDir, { recursive: true });
    const preexistingTarget = path.join(preexistingTargetDir, 'agent.md');
    writeFileSync(preexistingTarget, 'unrelated agent\n');
    symlinkSync(preexistingTarget, preexisting);

    // Force a failure at npm install.
    const env = makeFailureEnv();
    injectFailureAt(env, 'npm-install');

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    // Pre-existing symlink still present.
    expect(lstatSync(preexisting).isSymbolicLink()).toBe(true);
    expect(readlinkSync(preexisting)).toBe(preexistingTarget);
  });
});

/**
 * R2 sprint 2 — happy-path install tests for `install.sh`.
 *
 * Covers S2-AC1..S2-AC10:
 *   AC1  — clean install end-to-end: symlinks, JSON, zones, .gitignore,
 *          no leftover `.tmp.*` files.
 *   AC2  — idempotency: a second run produces no duplicates and does
 *          not re-invoke `npm`.
 *   AC3  — version-probe triggers reinstall when the on-disk binary
 *          reports a version different from `package.json`.
 *   AC4  — `--no-claude-code` skips MCP registration entirely.
 *   AC5  — single backup per machine (re-run produces no second file).
 *   AC6  — sorted-key JSON write (lex order, 2-space indent, trailing
 *          newline).
 *   AC7  — stale-symlink prune (pre-seed broken symlinks → removed).
 *   AC8  — pre-existing `.gan/` is named, not a hard abort; final
 *          status mentions the path and a `rm -rf` hint in backticks.
 *   AC9  — outside a git repo: zones not created, validate skipped,
 *          symlinks + MCP still happen.
 *   AC10 — F4 install-path discipline: when `npm install -g .` fails,
 *          stderr uses framework prose (no Node/npm prose tokens) and
 *          the retry command appears in backticks.
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
import {
  writeFakeNpm,
  writeFakeConfigServer,
  readNpmInvocations,
  npmInvocationLog,
  type FakeNpmOptions,
  type FakeConfigServerOptions,
} from './helpers/fakeNpm.js';
import { readClaudeJson, assertNoTmpFiles, assertSortedKeys } from './helpers/claudeJson.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

interface SetupOptions {
  /** Node version to report from the stub. Default `v20.10.0`. */
  nodeVersion?: string;
  /** Initialise a git repo at `<root>/repo/`. Default true. */
  withRepo?: boolean;
  /** Pre-existing `.gan/` directory at the repo top. Default false. */
  withPreexistingGan?: boolean;
  /** Fake-config-server options. If omitted, no stub written. */
  configServer?: FakeConfigServerOptions;
  /** Fake-npm options. If omitted, no stub written. */
  npm?: Omit<FakeNpmOptions, 'invocationLog'>;
  /** If true, write a `claude` stub (default true). */
  withClaude?: boolean;
}

interface SetupResult {
  tmp: TmpHome;
  pathOverride: string;
  cwd: string;
  npmLog: string;
}

function setup(opts: SetupOptions = {}): SetupResult {
  const tmp = makeTmpHome({ withRepo: opts.withRepo ?? true });
  cleanups.push(tmp);

  const v = opts.nodeVersion ?? 'v20.10.0';
  const hostNode = process.execPath;
  writeStubBin(
    tmp.bin,
    'node',
    `if [ "$1" = "--version" ]; then\n  printf '%s\\n' "${v}"\n  exit 0\nfi\nexec ${JSON.stringify(hostNode)} "$@"\n`,
  );
  writeStubBin(tmp.bin, 'git', `exec /usr/bin/git "$@"\n`);
  if (opts.withClaude !== false) {
    writeStubBin(tmp.bin, 'claude', 'exit 0');
  }

  const npmLog = npmInvocationLog(tmp.root);
  if (opts.npm) {
    writeFakeNpm(tmp.bin, { ...opts.npm, invocationLog: npmLog });
  }
  if (opts.configServer) {
    writeFakeConfigServer(tmp.bin, opts.configServer);
  }

  if (opts.withPreexistingGan && tmp.repo) {
    mkdirSync(path.join(tmp.repo, '.gan'), { recursive: true });
    writeFileSync(path.join(tmp.repo, '.gan', 'README'), 'legacy');
  }

  const cwd = tmp.repo ?? tmp.root;
  return { tmp, pathOverride: tmp.bin, cwd, npmLog };
}

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('install.sh — S2 happy-path install', () => {
  it('S2-AC1: clean install end-to-end (symlinks, JSON, zones, .gitignore, no tmp files)', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // Symlinks for every agent under `agents/`.
    const repoRoot = repoRootDir();
    const agentSrc = path.join(repoRoot, 'agents');
    for (const name of readdirSync(agentSrc)) {
      if (!name.endsWith('.md')) continue;
      const link = path.join(tmp.home, '.claude', 'agents', name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(path.join(agentSrc, name));
    }

    // Single skill symlink at `~/.claude/skills/gan`.
    const skillLink = path.join(tmp.home, '.claude', 'skills', 'gan');
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(skillLink)).toBe(path.join(repoRoot, 'skills', 'gan'));

    // `~/.claude.json` written with the registration entry.
    const cj = readClaudeJson(tmp.home);
    expect(cj).not.toBeNull();
    const mcp = (cj!.parsed as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(mcp['claudeagents-config']).toEqual({
      args: [],
      command: 'claudeagents-config-server',
      env: {},
    });

    // No leftover atomic-write tmp files.
    assertNoTmpFiles(tmp.home);

    // Zones created in the git repo, with .gitignore entries.
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(true);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(true);
    const gi = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    expect(gi).toContain('.gan-state/');
    expect(gi).toContain('.gan-cache/');
  });

  it('S2-AC2: idempotency — a second run produces no duplicates and does not re-invoke npm', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd, npmLog } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const r1 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);
    const r2 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);

    // The version-probe matches package.json on both runs, so npm is
    // never invoked.
    expect(readNpmInvocations(npmLog)).toEqual([]);

    // .gitignore must not have duplicates.
    const gi = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    const stateLines = gi.split('\n').filter((l) => l === '.gan-state/');
    const cacheLines = gi.split('\n').filter((l) => l === '.gan-cache/');
    expect(stateLines).toHaveLength(1);
    expect(cacheLines).toHaveLength(1);

    // Symlinks still resolve.
    const skillLink = path.join(tmp.home, '.claude', 'skills', 'gan');
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);

    // No tmp leftovers from atomic writes.
    assertNoTmpFiles(tmp.home);
  });

  it('S2-AC3: version-probe triggers a reinstall when on-disk version mismatches package.json', async () => {
    const { tmp, pathOverride, cwd, npmLog } = setup({
      configServer: { version: '0.0.99-mismatched' },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);
    const calls = readNpmInvocations(npmLog);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The expected call is `npm install -g .`.
    expect(calls[0]).toContain('install');
    expect(calls[0]).toContain('-g');
  });

  it('S2-AC4: --no-claude-code skips MCP registration entirely', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
      withClaude: false,
    });

    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(false);
    // Defense in depth: no backup either.
    const stragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(stragglers).toEqual([]);

    // Symlinks still happened.
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(true);
  });

  it('S2-AC5: single backup per machine (run twice → exactly one backup file)', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    // Pre-seed an existing `~/.claude.json` so the backup path is taken.
    writeFileSync(path.join(tmp.home, '.claude.json'), '{"existing":true}\n');

    const r1 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);
    const r2 = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);

    const backups = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(backups).toHaveLength(1);

    assertNoTmpFiles(tmp.home);
  });

  it('S2-AC6: sorted-key JSON write — lex order, 2-space indent, trailing newline', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    // Pre-seed `~/.claude.json` with keys in *non-sorted* order to
    // force the sort path to actually do work.
    writeFileSync(
      path.join(tmp.home, '.claude.json'),
      JSON.stringify({ z: 1, a: 2, mcpServers: { z: { args: [] } } }, null, 2) + '\n',
    );

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const cj = readClaudeJson(tmp.home);
    expect(cj).not.toBeNull();
    assertSortedKeys(cj!.raw);

    // Belt-and-braces: the registration entry made it through.
    const mcp = (cj!.parsed as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(mcp['claudeagents-config']).toBeDefined();

    assertNoTmpFiles(tmp.home);
  });

  it('S2-AC7: stale-symlink prune removes broken symlinks under ~/.claude/agents and ~/.claude/skills', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    // Pre-seed broken symlinks under both directories.
    mkdirSync(path.join(tmp.home, '.claude', 'agents'), { recursive: true });
    mkdirSync(path.join(tmp.home, '.claude', 'skills'), { recursive: true });
    const broken1 = path.join(tmp.home, '.claude', 'agents', 'retired-agent.md');
    const broken2 = path.join(tmp.home, '.claude', 'skills', 'retired-skill');
    symlinkSync('/path/that/does/not/exist/agent.md', broken1);
    symlinkSync('/path/that/does/not/exist/skill', broken2);

    expect(lstatSync(broken1).isSymbolicLink()).toBe(true);

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // Both broken symlinks should be gone after pruning.
    expect(existsSync(broken1)).toBe(false);
    expect(existsSync(broken2)).toBe(false);
    // Lstat must also fail (symlink itself removed, not just dangling).
    expect(() => lstatSync(broken1)).toThrow();
    expect(() => lstatSync(broken2)).toThrow();
  });

  it('S2-AC8: pre-existing `.gan/` is named in final status as a hand-delete target, not a hard abort', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
      withPreexistingGan: true,
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // The directory still exists (the installer must not delete it).
    expect(existsSync(path.join(cwd, '.gan'))).toBe(true);

    // The path is named in stdout.
    expect(result.stdout).toContain(path.join(cwd, '.gan'));
    // And the remediation hint mentions `rm -rf` in backticks.
    expect(result.stdout).toMatch(/`rm -rf [^`]+\.gan`/);
  });

  it('S2-AC9: outside a git repo — zones not created, validate skipped, symlinks + MCP still happen', async () => {
    const v = packageVersion();
    const { tmp, pathOverride } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
      withRepo: false,
    });
    // Run with cwd at the tmp root (no git repo above).
    const cwd = tmp.root;

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // No zones created at the tmp root.
    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    // Symlinks + MCP registration still happened.
    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(true);
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(true);
  });

  it('S2-AC10: F4 install-path discipline — npm failure stderr uses framework prose, no Node/npm prose tokens', async () => {
    const { tmp, pathOverride, cwd } = setup({
      // Leave config-server stub off so version-probe is empty and the
      // installer takes the `install_mcp_server` path.
      npm: { exitCode: 1, stderr: 'npm ERR! E_FAKE' },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).not.toBe(0);

    // The installer's own message (not the captured npm stderr) must
    // satisfy CC-PROSE. Find lines from the installer (prefixed with
    // `error:`) and run the prose check against those.
    const errorLines = result.stderr
      .split('\n')
      .filter((l) => l.startsWith('error:'))
      .join('\n');

    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...errorLines.matchAll(proseToken)].map((m) => m[0]);
    if (violations.length > 0) {
      throw new Error(
        `F4 prose violations in installer error lines: ${violations.join(', ')}\nLines:\n${errorLines}`,
      );
    }

    // The retry-command hint must appear in backticks.
    expect(errorLines).toMatch(/`npm install -g \.`/);
  });
});

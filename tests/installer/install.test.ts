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

    // Real-file copies for every agent under `agents/` (NOT symlinks —
    // post-symlink-to-copy migration). The install must be self-contained
    // so the source repo can be moved or deleted post-install.
    const repoRoot = repoRootDir();
    const agentSrc = path.join(repoRoot, 'agents');
    for (const name of readdirSync(agentSrc)) {
      if (!name.endsWith('.md')) continue;
      const target = path.join(tmp.home, '.claude', 'agents', name);
      const stat = lstatSync(target);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      // Content matches the source.
      expect(readFileSync(target, 'utf8')).toBe(readFileSync(path.join(agentSrc, name), 'utf8'));
    }

    // Real-directory copy at `~/.claude/skills/gan` (NOT a symlink).
    const skillTarget = path.join(tmp.home, '.claude', 'skills', 'gan');
    const skillStat = lstatSync(skillTarget);
    expect(skillStat.isSymbolicLink()).toBe(false);
    expect(skillStat.isDirectory()).toBe(true);
    // Content matches the source — at least SKILL.md.
    expect(readFileSync(path.join(skillTarget, 'SKILL.md'), 'utf8')).toBe(
      readFileSync(path.join(repoRoot, 'skills', 'gan', 'SKILL.md'), 'utf8'),
    );

    // `~/.claude.json` written with the registration entry. The command
    // is the absolute path to the bin (resolved via `command -v` at
    // install time) so macOS GUI-launched apps that inherit a minimal
    // PATH can still find the bin.
    const cj = readClaudeJson(tmp.home);
    expect(cj).not.toBeNull();
    const mcp = (cj!.parsed as { mcpServers: Record<string, unknown> }).mcpServers;
    const entry = mcp['claudeagents-config'] as {
      args: unknown;
      command: string;
      env: unknown;
    };
    expect(entry.args).toEqual([]);
    expect(entry.env).toEqual({});
    expect(typeof entry.command).toBe('string');
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(entry.command.endsWith('claudeagents-config-server')).toBe(true);

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

    // The version-probe matches package.json on both runs, so `npm
    // install` is never invoked. (Read-only `npm root -g` calls from
    // `create_builtin_stacks_symlink` are benign and ignored here.)
    const stateChanging = readNpmInvocations(npmLog).filter((line) => !line.startsWith('root -g'));
    expect(stateChanging).toEqual([]);

    // .gitignore must not have duplicates.
    const gi = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    const stateLines = gi.split('\n').filter((l) => l === '.gan-state/');
    const cacheLines = gi.split('\n').filter((l) => l === '.gan-cache/');
    expect(stateLines).toHaveLength(1);
    expect(cacheLines).toHaveLength(1);

    // Skill directory still exists as a real directory after re-run.
    const skillTarget = path.join(tmp.home, '.claude', 'skills', 'gan');
    const skillStat = lstatSync(skillTarget);
    expect(skillStat.isSymbolicLink()).toBe(false);
    expect(skillStat.isDirectory()).toBe(true);

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

  it('I2 sprint 3a: non-TTY install adds only category 1 (framework MCP) to permissions.allow', async () => {
    // Per `specifications/I2-install-user-facing-surfaces.md` § "Non-TTY
    // behavior": when stdin/stdout are not a TTY (CI, scripted
    // invocations, every test in this file), `configure_permissions`
    // skips the prompt sequence and adds only category 1 — the
    // framework MCP server, the only category whose absence would
    // break /gan entirely. Other categories stay unset; the user can
    // re-run install.sh interactively to add them.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { permissions: { allow: string[] } };

    // Category 1 is present.
    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*');
    // Categories 2+ are NOT present (sample assertions on entries that
    // would be added if the merge over-fired).
    expect(parsed.permissions.allow).not.toContain('Read');
    expect(parsed.permissions.allow).not.toContain('Write');
    expect(parsed.permissions.allow).not.toContain('Bash(git status:*)');
    expect(parsed.permissions.allow).not.toContain('Bash(npm install:*)');
  });

  it('I2 sprint 3a: settings.json is written sorted-key + 2-space-indent + trailing newline', async () => {
    // Mirror of the existing `~/.claude.json` write contract (S2-AC6),
    // applied to the new `~/.claude/settings.json` path. Keys must be
    // sorted; indentation must be 2 spaces; the file must end with a
    // single newline.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false); // exactly one trailing newline.
    // 2-space indent: the first nested key after the opening brace
    // should be preceded by exactly two spaces.
    expect(raw).toMatch(/\n  "permissions":/);
    // Sorted keys: re-stringify with sortedness and confirm match.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assertSortedKeys(raw);
    expect(typeof parsed['permissions']).toBe('object');
  });

  it('I2 sprint 3a: pre-existing user entries in permissions.allow survive the merge', async () => {
    // The merge must be additive, not destructive. A user who
    // pre-authored their own `permissions.allow` entry — say, a
    // project-specific tool the framework knows nothing about — must
    // see that entry preserved after install. Otherwise the install
    // would silently destroy user customisation, the worst kind of
    // failure mode.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    // Pre-seed a settings.json with a user entry the framework would
    // not add on its own.
    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['MyOwnTool'] } }, null, 2) + '\n',
      'utf8',
    );

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { permissions: { allow: string[] } };
    expect(parsed.permissions.allow).toContain('MyOwnTool');
    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*');
  });

  it('I2 sprint 3b: --approve-all-permissions adds every catalog tool to permissions.allow', async () => {
    // Per `specifications/I2-install-user-facing-surfaces.md` § "Override
    // flags": `--approve-all-permissions` grants categories 1-8 without
    // prompting. Useful for CI runners that test the framework end-to-
    // end.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall(['--approve-all-permissions'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { permissions: { allow: string[] } };

    // Spot-check entries from each non-required category.
    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*'); // cat 1
    expect(parsed.permissions.allow).toContain('Read'); // cat 2
    expect(parsed.permissions.allow).toContain('Agent'); // cat 3
    expect(parsed.permissions.allow).toContain('Bash(git status:*)'); // cat 4
    expect(parsed.permissions.allow).toContain('Bash(git commit:*)'); // cat 5
    expect(parsed.permissions.allow).toContain('Bash(npm test:*)'); // cat 6
    expect(parsed.permissions.allow).toContain('Bash(npm install:*)'); // cat 7
    expect(parsed.permissions.allow).toContain('Bash(ls:*)'); // cat 8
  });

  it('I2 sprint 3b: --minimal-permissions adds only category 1', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall(['--minimal-permissions'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[] };
    };
    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*');
    expect(parsed.permissions.allow).not.toContain('Read');
    expect(parsed.permissions.allow).not.toContain('Bash(git status:*)');
  });

  it('I2 sprint 3b: --approve-all-permissions and --minimal-permissions are mutually exclusive', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall(
      ['--approve-all-permissions', '--minimal-permissions'],
      { home: tmp.home, pathOverride, cwd },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--approve-all-permissions');
    expect(result.stderr).toContain('--minimal-permissions');
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('I2 sprint 3b: idempotent re-run after categories already granted adds no duplicates', async () => {
    // Pre-seed settings.json with categories 1 + 2 entries already
    // present. A re-run (non-TTY default = minimal, which is just
    // category 1) must not duplicate them and must not add anything
    // further: the additive merge sees every approved entry is already
    // present and the file content is preserved.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const preExisting = [
      'mcp__claudeagents-config__*',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ].sort();
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: preExisting } }, null, 2) + '\n',
      'utf8',
    );

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[] };
    };
    // No duplicates: each entry appears exactly once.
    const counts = new Map<string, number>();
    for (const t of parsed.permissions.allow) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
    // Pre-existing entries preserved exactly.
    for (const t of preExisting) expect(parsed.permissions.allow).toContain(t);
    // Category 3+ entries still absent (re-run did not add new categories).
    expect(parsed.permissions.allow).not.toContain('Agent');
    expect(parsed.permissions.allow).not.toContain('Bash(git status:*)');
  });

  it('I2 sprint 3b: --uninstall strips framework-added entries but preserves user-authored entries', async () => {
    // Per the I2 acceptance criterion: "removes only the entries
    // matching the framework's category templates; user-authored entries
    // in `permissions.allow` are left intact." Pre-seed a mix of
    // framework + user entries; uninstall; assert the result.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: {
            allow: [
              'MyOwnTool', // user-authored
              'mcp__claudeagents-config__*', // framework cat 1
              'Read', // framework cat 2
              'AnotherUserTool', // user-authored
            ].sort(),
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const result = await runInstall(['--uninstall'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    const remaining = parsed.permissions?.allow ?? [];
    // User entries preserved.
    expect(remaining).toContain('MyOwnTool');
    expect(remaining).toContain('AnotherUserTool');
    // Framework entries gone.
    expect(remaining).not.toContain('mcp__claudeagents-config__*');
    expect(remaining).not.toContain('Read');
  });

  it('I2 sprint 4: --reconfigure-permissions runs cleanly in non-TTY mode (no prompt; no error)', async () => {
    // The interactive re-prompt is only useful in TTY mode; in non-TTY
    // the flag is a no-op (the default-minimal branch fires regardless).
    // This test confirms the flag does not crash, error, or change the
    // result vs. a default install — a regression that left the flag
    // unparsed would surface as an "unknown flag" exit-2 error.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall(['--reconfigure-permissions'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);
    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('I2 sprint 4: --no-claude-code skips configure_permissions (no settings.json written)', async () => {
    // Regression guard for the wiring: configure_permissions lives
    // inside the `if [ "$skip_claude_code" -eq 0 ]` block in main(),
    // so --no-claude-code must skip it entirely. The original
    // --no-claude-code test only asserted `~/.claude.json` is absent;
    // this asserts the symmetric `~/.claude/settings.json` is also
    // absent. Without the guard, a refactor that moved the call out
    // of the block would silently start writing settings.json on CI
    // installs that opted out of Claude Code entirely.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall(['--no-claude-code'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);
    const settingsPath = path.join(tmp.home, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('I2 sprint 1: post-install success message contains both the restart hint and the `/gan --help` hint', async () => {
    // Per `specifications/I2-install-user-facing-surfaces.md` § "Post-
    // install message: name the next step", the success message must
    // tell the user (a) to restart Claude Code and (b) what to type
    // first after restart. The `/gan --help` hint is significant because
    // it short-circuits before validation, giving a fresh user something
    // concrete to run before they have authored an overlay or a sprint.
    //
    // Loose substring assertions so trivial wording adjustments do not
    // break the test, but tight enough to catch either line being
    // dropped wholesale.
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Restart Claude Code');
    expect(result.stdout).toContain('gan --help');
  });
});

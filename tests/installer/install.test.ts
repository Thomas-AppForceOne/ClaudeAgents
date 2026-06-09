/**
 * End-to-end coverage for the S2 happy-path install plus the I2 permissions
 * sprints. This is the broadest installer suite: it drives the real install.sh
 * with fully stubbed npm / config-server / node / git and asserts on the whole
 * resulting filesystem + `~/.claude.json` + `~/.claude/settings.json`.
 *
 * What this verifies (selected):
 * - S2-AC1: a clean install copies agents (real files, not symlinks), links the
 *   skill dir, registers the framework MCP entry with an absolute command path,
 *   creates the `.gan-state` / `.gan-cache` zones, gitignores them, and leaves
 *   no temp files.
 * - S2-AC2: a second run is idempotent and does NOT re-invoke `npm install`.
 * - S2-AC3: a version mismatch between the on-disk config-server and
 *   package.json forces a reinstall.
 * - S2-AC5/AC6: exactly one `.claude.json` backup per machine; the JSON is
 *   written sorted-key / 2-space / trailing-newline.
 * - S2-AC7: broken stale symlinks under `~/.claude/agents` & `skills` are pruned.
 * - S2-AC8: a non-empty legacy `.gan/` is named as a hand-delete target (not a
 *   hard abort); an empty one produces no warning.
 * - S2-AC9: outside a git repo, zones/validate are skipped but symlinks + MCP
 *   still happen.
 * - S2-AC10 / G1: installer error prose obeys the F4 discipline.
 * - I2 sprint 3/4: permission categories are merged additively into
 *   settings.json (cat-1 only by default; everything under
 *   `--approve-all-permissions`; cat-1 only under `--minimal-permissions`; the
 *   two flags are mutually exclusive), re-runs add no duplicates, and
 *   `--uninstall` strips framework-added entries while preserving user-authored
 *   ones.
 *
 * What it guards (WHY): the install must be additive and reversible — it never
 * clobbers a user's existing `.claude.json` / settings.json content, never
 * leaves crash debris, and a second run is a no-op. The setup helper centralises
 * the stub matrix so each test only states the variation it cares about.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

  nodeVersion?: string;

  withRepo?: boolean;

  withPreexistingGan?: boolean;

  configServer?: FakeConfigServerOptions;

  npm?: Omit<FakeNpmOptions, 'invocationLog'>;

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

    const repoRoot = repoRootDir();
    const agentSrc = path.join(repoRoot, 'agents');
    for (const name of readdirSync(agentSrc)) {
      if (!name.endsWith('.md')) continue;
      const target = path.join(tmp.home, '.claude', 'agents', name);
      // Agents must be COPIED (real files), not symlinked — a symlink would
      // break once the framework checkout moves. Content equality below proves
      // the copy is faithful.
      const stat = lstatSync(target);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);

      expect(readFileSync(target, 'utf8')).toBe(readFileSync(path.join(agentSrc, name), 'utf8'));
    }

    const skillTarget = path.join(tmp.home, '.claude', 'skills', 'gan');
    const skillStat = lstatSync(skillTarget);
    expect(skillStat.isSymbolicLink()).toBe(false);
    expect(skillStat.isDirectory()).toBe(true);

    expect(readFileSync(path.join(skillTarget, 'SKILL.md'), 'utf8')).toBe(
      readFileSync(path.join(repoRoot, 'skills', 'gan', 'SKILL.md'), 'utf8'),
    );

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

    assertNoTmpFiles(tmp.home);

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

    // `npm root -g` is a read-only lookup the installer may repeat; filtering
    // it out leaves only state-changing calls (notably `install` and the
    // bootstrap `ci`). The second run must make none — that is the idempotency
    // guarantee. The version-probe gate plus the bootstrap's warm-tree guard
    // (current `dist/` present) together ensure neither `install -g` nor `ci`
    // is re-run on a warm, version-matched tree.
    const stateChanging = readNpmInvocations(npmLog).filter((line) => !line.startsWith('root -g'));
    expect(stateChanging).toEqual([]);
    // Explicitly confirm the bootstrap dependency install is absent on a warm
    // re-run (the [] assertion above already implies this; this names it).
    expect(stateChanging.some((line) => line.split(/\s+/)[0] === 'ci')).toBe(false);

    const gi = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    const stateLines = gi.split('\n').filter((l) => l === '.gan-state/');
    const cacheLines = gi.split('\n').filter((l) => l === '.gan-cache/');
    expect(stateLines).toHaveLength(1);
    expect(cacheLines).toHaveLength(1);

    const skillTarget = path.join(tmp.home, '.claude', 'skills', 'gan');
    const skillStat = lstatSync(skillTarget);
    expect(skillStat.isSymbolicLink()).toBe(false);
    expect(skillStat.isDirectory()).toBe(true);

    assertNoTmpFiles(tmp.home);
  });

  it('S2-AC3: version-probe triggers a reinstall when on-disk version mismatches package.json', async () => {
    // The stub config-server reports a version that does NOT match the repo's
    // package.json, so the installer should conclude the global install is
    // stale and re-run `npm install -g`.
    const { tmp, pathOverride, cwd, npmLog } = setup({
      configServer: { version: '0.0.99-mismatched' },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);
    const calls = readNpmInvocations(npmLog);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Find the GLOBAL-INSTALL invocation specifically. The bootstrap step now
    // logs `npm ci` before `npm install -g .`, so `calls[0]` is no longer
    // guaranteed to be the global install — assert the reinstall happened by
    // locating the `install -g` call directly.
    const globalInstall = calls.find((c) => c.includes('install') && c.includes('-g'));
    expect(globalInstall).toBeDefined();
  });

  it('cold install bootstraps the build: `npm ci` runs before `npm install -g .`', async () => {
    // The repo under test is already built (`dist/` present), so the bootstrap
    // warm-tree guard would normally skip the dependency install. `CAS_FORCE_
    // BOOTSTRAP=1` forces the cold path so we can assert ordering: the
    // bootstrap `npm ci --ignore-scripts` must precede the global
    // `npm install -g .`.
    const { tmp, pathOverride, cwd, npmLog } = setup({
      configServer: { version: '0.0.99-mismatched' },
      npm: { exitCode: 0 },
    });

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: { CAS_FORCE_BOOTSTRAP: '1' },
    });
    expect(result.exitCode).toBe(0);

    const calls = readNpmInvocations(npmLog);
    const ciIndex = calls.findIndex((c) => c.split(/\s+/)[0] === 'ci');
    const globalInstallIndex = calls.findIndex((c) => c.includes('install') && c.includes('-g'));
    expect(ciIndex).toBeGreaterThanOrEqual(0);
    expect(globalInstallIndex).toBeGreaterThanOrEqual(0);
    expect(ciIndex).toBeLessThan(globalInstallIndex);
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

    const stragglers = readdirSync(tmp.home).filter((e) => e.startsWith('.claude.json.backup-'));
    expect(stragglers).toEqual([]);

    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(true);
  });

  it('S2-AC5: single backup per machine (run twice → exactly one backup file)', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

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

    writeFileSync(
      path.join(tmp.home, '.claude.json'),
      JSON.stringify({ z: 1, a: 2, mcpServers: { z: { args: [] } } }, null, 2) + '\n',
    );

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const cj = readClaudeJson(tmp.home);
    expect(cj).not.toBeNull();
    assertSortedKeys(cj!.raw);

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

    mkdirSync(path.join(tmp.home, '.claude', 'agents'), { recursive: true });
    mkdirSync(path.join(tmp.home, '.claude', 'skills'), { recursive: true });
    // Seed dangling symlinks (targets deliberately don't exist) to stand in for
    // agents/skills retired in a prior framework version; the installer should
    // prune these broken links during the symlink-refresh pass.
    const broken1 = path.join(tmp.home, '.claude', 'agents', 'retired-agent.md');
    const broken2 = path.join(tmp.home, '.claude', 'skills', 'retired-skill');
    symlinkSync('/path/that/does/not/exist/agent.md', broken1);
    symlinkSync('/path/that/does/not/exist/skill', broken2);

    expect(lstatSync(broken1).isSymbolicLink()).toBe(true);

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(existsSync(broken1)).toBe(false);
    expect(existsSync(broken2)).toBe(false);

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

    expect(existsSync(path.join(cwd, '.gan'))).toBe(true);

    expect(result.stdout).toContain(path.join(cwd, '.gan'));

    expect(result.stdout).toMatch(/`rm -rf [^`]+\.gan`/);
  });

  it('S2-AC8 follow-up: an empty `.gan/` does NOT produce a warning (no data to preserve)', async () => {
    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

    mkdirSync(path.join(cwd, '.gan'), { recursive: true });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(result.stdout).not.toContain('legacy `.gan/`');
    expect(result.stdout).not.toMatch(/`rm -rf [^`]+\.gan`/);
    expect(existsSync(path.join(cwd, '.gan'))).toBe(true);
  });

  it('S2-AC9: outside a git repo — zones not created, validate skipped, symlinks + MCP still happen', async () => {
    const v = packageVersion();
    const { tmp, pathOverride } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
      withRepo: false,
    });

    const cwd = tmp.root;

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(existsSync(path.join(cwd, '.gan-state'))).toBe(false);
    expect(existsSync(path.join(cwd, '.gan-cache'))).toBe(false);

    expect(existsSync(path.join(tmp.home, '.claude', 'skills', 'gan'))).toBe(true);
    expect(existsSync(path.join(tmp.home, '.claude.json'))).toBe(true);
  });

  it('S2-AC10: F4 install-path discipline — npm failure stderr uses framework prose, no Node/npm prose tokens', async () => {
    // No configServer stub here: with npm forced to exit 1, install fails before
    // the version probe matters. The point is to inspect the installer's OWN
    // error lines (prefixed `error:`), not npm's raw chatter.
    const { tmp, pathOverride, cwd } = setup({

      npm: { exitCode: 1, stderr: 'npm ERR! E_FAKE' },
    });

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).not.toBe(0);

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

    expect(errorLines).toMatch(/`npm install -g \.`/);
  });

  it('I2 sprint 3a: non-TTY install adds only category 1 (framework MCP) to permissions.allow', async () => {

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

    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*');

    expect(parsed.permissions.allow).not.toContain('Read');
    expect(parsed.permissions.allow).not.toContain('Write');
    expect(parsed.permissions.allow).not.toContain('Bash(git status:*)');
    expect(parsed.permissions.allow).not.toContain('Bash(npm install:*)');
  });

  it('I2 sprint 3a: settings.json is written sorted-key + 2-space-indent + trailing newline', async () => {

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
    expect(raw.endsWith('\n\n')).toBe(false);

    expect(raw).toMatch(/\n  "permissions":/);

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assertSortedKeys(raw);
    expect(typeof parsed['permissions']).toBe('object');
  });

  it('I2 sprint 3a: pre-existing user entries in permissions.allow survive the merge', async () => {

    const v = packageVersion();
    const { tmp, pathOverride, cwd } = setup({
      configServer: { version: v },
      npm: { exitCode: 0 },
    });

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

    expect(parsed.permissions.allow).toContain('mcp__claudeagents-config__*');
    expect(parsed.permissions.allow).toContain('Read');
    expect(parsed.permissions.allow).toContain('Agent');
    expect(parsed.permissions.allow).toContain('Bash(git status:*)');
    expect(parsed.permissions.allow).toContain('Bash(git commit:*)');
    expect(parsed.permissions.allow).toContain('Bash(npm test:*)');
    expect(parsed.permissions.allow).toContain('Bash(npm install:*)');
    expect(parsed.permissions.allow).toContain('Bash(ls:*)');
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

    const result = await runInstall(['--approve-all-permissions', '--minimal-permissions'], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--approve-all-permissions');
    expect(result.stderr).toContain('--minimal-permissions');
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('I2 sprint 3b: idempotent re-run after categories already granted adds no duplicates', async () => {

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

    // Tally each allow-entry: every count must be exactly 1, i.e. the merge
    // added no duplicates of entries that were already granted.
    const counts = new Map<string, number>();
    for (const t of parsed.permissions.allow) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);

    for (const t of preExisting) expect(parsed.permissions.allow).toContain(t);

    expect(parsed.permissions.allow).not.toContain('Agent');
    expect(parsed.permissions.allow).not.toContain('Bash(git status:*)');
  });

  it('I2 sprint 3b: --uninstall strips framework-added entries but preserves user-authored entries', async () => {

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

    expect(remaining).toContain('MyOwnTool');
    expect(remaining).toContain('AnotherUserTool');

    expect(remaining).not.toContain('mcp__claudeagents-config__*');
    expect(remaining).not.toContain('Read');
  });

  it('I2 sprint 4: --reconfigure-permissions runs cleanly in non-TTY mode (no prompt; no error)', async () => {

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

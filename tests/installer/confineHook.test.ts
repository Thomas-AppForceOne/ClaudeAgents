/**
 * Install / uninstall coverage for the H1 confinement hook: writing the
 * `gan-confine.sh` file and registering it in `~/.claude/settings.json` as a
 * PreToolUse hook (and removing both on `--uninstall`).
 *
 * What this verifies, by acceptance criterion:
 * - AC-A1: the hook is rendered byte-identical to the shipped template, is
 *   executable, version-correct, and references the F1 zone vars.
 * - AC-A2: registration uses the ABSOLUTE hook path and merges additively into
 *   a pre-existing settings.json (unrelated hooks/keys survive).
 * - AC-A3: re-running overwrites a stale hook and never duplicates the
 *   registration; the settings file is byte-stable across re-runs.
 * - AC-A6/A7/M2: a project-tier hook in the cwd suppresses nothing but DOES
 *   fire the canonical override warning (with exact prose, backticked tokens,
 *   and no bare runtime tokens), and the project file is never touched.
 * - AC-A4: a failure after the hook write rolls back BOTH the partial hook and
 *   the settings registration — a newly-created settings.json is removed, a
 *   pre-existing one is byte-restored, and no tmp/preedit stragglers remain.
 * - AC-A5 (uninstall): only the framework PreToolUse entry is stripped;
 *   unrelated entries, near-miss commands, and user permissions survive.
 *
 * What it guards (WHY): the hook is a security control, so its registration
 * must be exact (absolute path, single entry), non-destructive to user config,
 * fully reversible on partial failure, and immune to shell injection via a
 * repo path containing metacharacters. The `#!/bin/bash` strings and embedded
 * shell here are DATA written into fixtures, not directives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeNpm, writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';
import { injectFailureAt, makeFailureEnv } from './helpers/failurePoints.js';
import { renderedTemplate } from './helpers/confineTemplate.js';

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

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function setup(): SetupResult {
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
  const npmLog = npmInvocationLog(tmp.root);
  writeFakeNpm(tmp.bin, { exitCode: 0, invocationLog: npmLog });

  writeFakeConfigServer(tmp.bin, { version: packageVersion() });
  return { tmp, pathOverride: tmp.bin, cwd: tmp.repo!, npmLog };
}

function hookPath(home: string): string {
  return path.join(home, '.claude', 'hooks', 'gan-confine.sh');
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

interface SettingsShape {
  hooks?: { PreToolUse?: unknown[] };
  permissions?: { allow?: unknown[] };
  [k: string]: unknown;
}

function readSettings(home: string): SettingsShape {
  return JSON.parse(readFileSync(settingsPath(home), 'utf8')) as SettingsShape;
}

// Flatten every PreToolUse command string out of settings.json. Claude Code
// accepts two shapes — a flat `{ command }` entry and a `{ hooks: [{ command }]
// }` matcher group — so both are harvested to give a single list to assert on.
function preToolUseCommands(settings: SettingsShape): string[] {
  const out: string[] = [];
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    if (entry && typeof entry === 'object') {
      const e = entry as { command?: unknown; hooks?: unknown[] };
      if (typeof e.command === 'string') out.push(e.command);
      for (const h of e.hooks ?? []) {
        if (h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string') {
          out.push((h as { command: string }).command);
        }
      }
    }
  }
  return out;
}

describe('install.sh — H1 confinement hook write + registration', () => {
  it('AC-A1: renders the hook from the template, executable, version-correct, F1 zones present, body byte-identical', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);

    const st = statSync(hp);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o100).toBe(0o100);

    const onDisk = readFileSync(hp, 'utf8');

    expect(onDisk).toMatch(
      new RegExp(
        `Source of truth: ClaudeAgents framework, version ${packageVersion().replace(/\./g, '\\.')}\\.`,
      ),
    );

    expect(onDisk).toContain('GAN_WORKTREE');
    expect(onDisk).toContain('GAN_RUN_DIR');
    expect(onDisk).toContain('worktree');
    expect(onDisk).not.toContain('.gan-state/runs/$GAN_RUN_ID/worktree');

    expect(onDisk).toBe(renderedTemplate());
  });

  it('AC-A2: settings.json hooks.PreToolUse[] registers the ABSOLUTE hook path; merge is additive', async () => {
    const { tmp, pathOverride, cwd } = setup();

    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    const preExisting = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/user-audit.sh' }] },
        ],
      },
      permissions: { allow: ['Read(//etc/hosts)'] },
      someUnrelatedKey: 42,
    };
    writeFileSync(settingsPath(tmp.home), JSON.stringify(preExisting, null, 2) + '\n');

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const settings = readSettings(tmp.home);
    const cmds = preToolUseCommands(settings);

    const expectedAbs = hookPath(tmp.home);
    expect(cmds).toContain(expectedAbs);
    expect(expectedAbs.startsWith('/')).toBe(true);

    for (const c of cmds) {
      expect(c.startsWith('~')).toBe(false);
      expect(c.startsWith('/')).toBe(true);
    }

    expect(cmds).toContain('/usr/local/bin/user-audit.sh');

    expect(settings.permissions?.allow).toContain('Read(//etc/hosts)');
    expect(settings.someUnrelatedKey).toBe(42);
  });

  it('AC-A3 + idempotency: re-running install overwrites a stale hook and does not duplicate the registration', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const first = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(first.exitCode).toBe(0);

    const hp = hookPath(tmp.home);

    // Corrupt the installed hook with stale content (an old `.gan/` zone hook),
    // then re-run install to prove the second run overwrites it back to the
    // current template rather than leaving the stale body in place.
    writeFileSync(hp, '#!/bin/bash\n# STALE legacy .gan/ zone hook\nexit 0\n');
    expect(readFileSync(hp, 'utf8')).not.toBe(renderedTemplate());

    // Snapshot settings.json after the first install so we can later prove the
    // re-run left it byte-identical (idempotent registration, no duplicate).
    const settingsAfterFirst = readFileSync(settingsPath(tmp.home), 'utf8');

    const second = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);

    expect(readFileSync(hp, 'utf8')).toBe(renderedTemplate());

    const settings = readSettings(tmp.home);
    const matches = preToolUseCommands(settings).filter((c) => c === hp);
    expect(matches).toHaveLength(1);

    expect(readFileSync(settingsPath(tmp.home), 'utf8')).toBe(settingsAfterFirst);

    const hooksDir = path.dirname(hp);
    const claudeDir = path.dirname(settingsPath(tmp.home));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(hooksDir).filter((e) => e.includes('.tmp.'))).toEqual([]);
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });

  function projectHookPath(repo: string): string {
    return path.join(repo, '.claude', 'hooks', 'gan-confine.sh');
  }

  const CANONICAL_WARNING =
    'A project-tier confinement hook is present at `.claude/hooks/gan-confine.sh`. ' +
    "The framework's user-tier hook at `~/.claude/hooks/gan-confine.sh` will not be used " +
    "in this project. Verify the project hook still reflects the framework's current " +
    'zone layout (see F1).';

  const WARNING_PROBE = 'A project-tier confinement hook is present at';

  it('AC-A6: with NO project-tier hook, install writes the user-tier hook + registration and the override warning does NOT fire', async () => {
    const { tmp, pathOverride, cwd } = setup();

    expect(existsSync(projectHookPath(cwd))).toBe(false);

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(statSync(hp).mode & 0o100).toBe(0o100);

    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    expect(result.stdout + result.stderr).not.toContain(WARNING_PROBE);
  });

  it('AC-A7: with a pre-seeded project-tier hook, install still writes only the user-tier hook + registration, never touches the project file, and the override warning FIRES', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const php = projectHookPath(cwd);
    mkdirSync(path.dirname(php), { recursive: true });
    const sentinel =
      '#!/bin/bash\n# PROJECT-TIER OVERRIDE — sentinel content, do not touch.\nexit 0\n';
    writeFileSync(php, sentinel);
    chmodSync(php, 0o755);
    // Capture the project hook's mtime so we can assert install never even
    // rewrote it with identical bytes — the file must be left wholly untouched.
    const sentinelMtimeNs = statSync(php).mtimeMs;

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(statSync(hp).mode & 0o100).toBe(0o100);
    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    expect(readFileSync(php, 'utf8')).toBe(sentinel);
    expect(statSync(php).mtimeMs).toBe(sentinelMtimeNs);

    expect(result.stdout).toContain(WARNING_PROBE);
  });

  it('AC-M2: the emitted override warning matches the canonical spec text, references the framework / user-tier hook, recommends `gan hooks status` in backticks, and carries no bare runtime token', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const php = projectHookPath(cwd);
    mkdirSync(path.dirname(php), { recursive: true });
    writeFileSync(php, '#!/bin/bash\nexit 0\n');

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const out = result.stdout;

    expect(out).toContain(CANONICAL_WARNING);

    expect(out).toContain('`.claude/hooks/gan-confine.sh`');
    expect(out).toContain('`~/.claude/hooks/gan-confine.sh`');
    expect(out).toContain('will not be used in this project');
    expect(out).toContain("reflects the framework's current zone layout");
    expect(out).toContain('(see F1)');
    expect(out).toContain('the framework');
    expect(out).toContain('user-tier hook');

    expect(out).toContain('`gan hooks status`');

    // F4 prose discipline: runtime tokens (npm/node/etc.) may appear only
    // inside backticked code spans. Strip the backticked spans from the warning
    // lines, then assert none of the forbidden tokens survive in bare prose.
    const warningLines = out
      .split('\n')
      .filter((l) => l.includes('confinement hook') || l.includes('gan hooks status'));
    expect(warningLines.length).toBeGreaterThan(0);
    const outsideBackticks = warningLines.join('\n').replace(/`[^`]*`/g, '');
    for (const token of ['npm', 'node', 'MCP server', 'npm package', 'npm run']) {
      expect(outsideBackticks).not.toContain(token);
    }
  });

  it('AC-A4: a post-hook-write failure rolls back the partial hook AND the settings registration (newly created settings.json)', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const env = makeFailureEnv();
    injectFailureAt(env, 'confine-hook-write');

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(existsSync(hookPath(tmp.home))).toBe(false);

    expect(existsSync(settingsPath(tmp.home))).toBe(false);

    const claudeDir = path.join(tmp.home, '.claude');
    const { readdirSync } = await import('node:fs');
    if (existsSync(claudeDir)) {
      expect(
        readdirSync(claudeDir).filter(
          (e) => e.startsWith('settings.json.tmp.') || e.startsWith('settings.json.preedit-'),
        ),
      ).toEqual([]);
    }
  });

  it('AC-A4: post-hook-write failure restores a PRE-EXISTING settings.json byte-for-byte (registration gone)', async () => {
    const { tmp, pathOverride, cwd } = setup();

    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    const preState =
      JSON.stringify(
        {
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/keep.sh' }] }] },
          permissions: { allow: ['Read(//tmp/x)'] },
        },
        Object.keys({ hooks: 0, permissions: 0 }).sort(),
        2,
      ) + '\n';
    writeFileSync(settingsPath(tmp.home), preState);

    const env = makeFailureEnv();
    injectFailureAt(env, 'confine-hook-write');

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    expect(existsSync(hookPath(tmp.home))).toBe(false);

    const post = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(post).toBe(preState);
    expect(preToolUseCommands(JSON.parse(post) as SettingsShape)).not.toContain(hookPath(tmp.home));

    const claudeDir = path.join(tmp.home, '.claude');
    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(claudeDir).filter(
        (e) => e.startsWith('settings.json.tmp.') || e.startsWith('settings.json.preedit-'),
      ),
    ).toEqual([]);
  });
});

describe('install.sh --uninstall — H1 confinement hook removal + PreToolUse strip (AC-A5)', () => {
  it('removes the user-tier hook file and strips ONLY the framework PreToolUse entry; unrelated entries + keys survive', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    const settings = readSettings(tmp.home);
    const pre = settings.hooks?.PreToolUse ?? [];
    settings.hooks = {
      PreToolUse: [
        ...pre,
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/user-audit.sh' }] },
      ],
    };
    (settings as Record<string, unknown>).keepMe = 'survivor';
    writeFileSync(settingsPath(tmp.home), JSON.stringify(settings, null, 2) + '\n');

    const result = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(existsSync(hp)).toBe(false);

    const after = readSettings(tmp.home);
    const cmds = preToolUseCommands(after);
    expect(cmds).not.toContain(hp);
    expect(cmds).toContain('/usr/local/bin/user-audit.sh');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

    const raw = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const reparsed = JSON.parse(raw) as SettingsShape;
    expect(JSON.stringify(reparsed)).toBeTruthy();

    const claudeDir = path.dirname(settingsPath(tmp.home));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });

  it('does NOT touch a project-tier hook in the cwd, and is idempotent (second uninstall exits 0, removes nothing further)', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const php = path.join(cwd, '.claude', 'hooks', 'gan-confine.sh');
    mkdirSync(path.dirname(php), { recursive: true });
    const sentinel = '#!/bin/bash\n# PROJECT OVERRIDE sentinel.\nexit 0\n';
    writeFileSync(php, sentinel);

    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(true);

    const first = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(first.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(false);

    expect(readFileSync(php, 'utf8')).toBe(sentinel);

    const second = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(false);

    expect(readFileSync(php, 'utf8')).toBe(sentinel);
  });

  it('preserves unrelated settings end-to-end: an adversarial near-miss command + user permissions.allow survive the strip', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    const hp = hookPath(tmp.home);

    const settings = readSettings(tmp.home);
    const pre = settings.hooks?.PreToolUse ?? [];
    settings.hooks = {
      PreToolUse: [
        ...pre,
        { matcher: 'Read', hooks: [{ type: 'command', command: `/opt/wrap ${hp}` }] },
        { matcher: 'Write', command: `${hp}.bak` },
      ],
    };
    settings.permissions = { allow: ['Read(//etc/hosts)', 'Bash(echo:*)'] };
    writeFileSync(settingsPath(tmp.home), JSON.stringify(settings, null, 2) + '\n');

    const result = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const after = readSettings(tmp.home);
    const cmds = preToolUseCommands(after);

    expect(cmds).not.toContain(hp);

    expect(cmds).toContain(`/opt/wrap ${hp}`);
    expect(cmds).toContain(`${hp}.bak`);

    expect(after.permissions?.allow).toContain('Read(//etc/hosts)');
  });

  it('survives an adversarial repo path containing shell metacharacters without command injection (detection is read-only + quoted)', async () => {

    const tmp = makeTmpHome({ withRepo: false });
    cleanups.push(tmp);
    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      [
        `if [ "$1" = "--version" ]; then printf '%s\\n' "v20.10.0"; exit 0; fi`,
        `exec ${JSON.stringify(hostNode)} "$@"`,
      ].join('\n'),
    );
    writeStubBin(tmp.bin, 'git', `exec /usr/bin/git "$@"\n`);
    writeStubBin(tmp.bin, 'claude', 'exit 0');
    writeFakeNpm(tmp.bin, { exitCode: 0, invocationLog: npmInvocationLog(tmp.root) });
    writeFakeConfigServer(tmp.bin, { version: packageVersion() });

    // The repo dir name embeds a command-substitution and backtick payload; if
    // any installer code path interpolated this path unquoted into a shell
    // command, the `touch PWNED` would fire. The later existence checks confirm
    // it never did.
    const hostileRepo = path.join(tmp.root, 'evil $(touch PWNED);` ` repo');
    mkdirSync(hostileRepo, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['init', '--quiet', hostileRepo], { stdio: 'ignore' }).status).toBe(0);
    const php = path.join(hostileRepo, '.claude', 'hooks', 'gan-confine.sh');
    mkdirSync(path.dirname(php), { recursive: true });
    writeFileSync(php, '#!/bin/bash\nexit 0\n');

    const result = await runInstall([], { home: tmp.home, pathOverride: tmp.bin, cwd: hostileRepo });
    expect(result.exitCode).toBe(0);

    expect(existsSync(path.join(hostileRepo, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);

    expect(result.stdout).toContain('A project-tier confinement hook is present at');

    expect(readFileSync(php, 'utf8')).toBe('#!/bin/bash\nexit 0\n');
  });
});

/**
 * H1 sprints 2 + 3 — install integration tests for the framework-owned
 * PreToolUse confinement hook.
 *
 * Every install/uninstall invocation here runs against a sandboxed `$HOME`
 * (via makeTmpHome) so the developer's real `~/.claude/` is never touched.
 *
 * Covers (sprint 2):
 *   AC-A1 — hook rendered from the template, executable, version-correct,
 *           carries F1 zone references; hook body is byte-identical to the
 *           template's non-placeholder lines (rendered against the running
 *           framework version, not a hardcoded golden).
 *   AC-A2 — settings.json `hooks.PreToolUse[]` carries the ABSOLUTE hook path;
 *           the merge is additive (pre-seeded unrelated PreToolUse entry +
 *           other settings survive).
 *   AC-A3 — re-running install overwrites a stale on-disk hook and does not
 *           duplicate the registration (idempotent).
 *   AC-A4 — a post-hook-write failure triggers rollback: the partial hook is
 *           removed and the settings.json registration is gone.
 *
 * Covers (sprint 3):
 *   AC-A5 — `--uninstall` removes the user-tier hook file AND surgically
 *           strips the framework's PreToolUse registration; unrelated
 *           PreToolUse entries + other settings survive; idempotent.
 *   AC-A6 (framework-contribution split) — install with NO project-tier hook
 *           writes the user-tier hook + registration; the override warning
 *           does NOT fire.
 *   AC-A7 (framework-contribution split) — install with a pre-seeded
 *           project-tier hook still writes only the user-tier hook +
 *           registration, never touches the project-tier file, and fires the
 *           override warning.
 *   AC-M2 — the emitted override warning matches the canonical spec text and
 *           carries no bare runtime/package-manager token outside backticks.
 *
 * NOTE on the non-blocking manual criterion
 * (manual_claude_code_resolver_precedence_semantics): the precedence rule
 * itself — Claude Code's hook resolver running the project-tier hook over the
 * user-tier hook when both are registered — is DOCUMENTED Claude Code
 * behavior, not something this repo re-implements. H1 § "Project-tier override
 * pattern" cites it; install.sh only writes the user-tier hook and warns about
 * a project-tier override, never re-implementing or exercising the resolver.
 * That half of AC-A6/AC-A7 is deliberately reviewer-confirmed, not automated
 * here (the real `~/.claude/` cannot be mutated and the resolver is not under
 * test). The framework's testable contribution is fully covered by the AC-A6
 * and AC-A7 cases below.
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

/** Render the source-of-truth template for the running framework version. */
function renderedTemplate(): string {
  const tpl = readFileSync(
    path.join(repoRootDir(), 'scripts', 'hooks', 'gan-confine.sh.template'),
    'utf8',
  );
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(packageVersion());
}

/**
 * Full happy-path setup: stub node (delegating to the real interpreter for
 * `-e` / `-p`), git, claude, npm, and a config-server reporting the running
 * package version so `install_mcp_server` is skipped (keeps the run light).
 */
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
  // Version-probe match → skip the heavy `npm install -g .` step.
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

/** All command strings referenced anywhere under hooks.PreToolUse[]. */
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

    // Regular file with the owner-executable bit set.
    const st = statSync(hp);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o100).toBe(0o100);

    const onDisk = readFileSync(hp, 'utf8');

    // Header carries exactly the running framework version.
    expect(onDisk).toMatch(
      new RegExp(
        `Source of truth: ClaudeAgents framework, version ${packageVersion().replace(/\./g, '\\.')}\\.`,
      ),
    );

    // F1 zone references carried from the template.
    expect(onDisk).toContain('.gan-state/runs');
    expect(onDisk).toContain('worktree');
    expect(onDisk).toContain('.gan-state/modules');

    // Body is exactly the rendered template (no inline re-authoring).
    expect(onDisk).toBe(renderedTemplate());
  });

  it('AC-A2: settings.json hooks.PreToolUse[] registers the ABSOLUTE hook path; merge is additive', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // Pre-seed settings.json with an unrelated PreToolUse entry and an
    // unrelated permissions block.
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

    // Framework entry present, absolute, under the sandbox $HOME/.claude/hooks.
    const expectedAbs = hookPath(tmp.home);
    expect(cmds).toContain(expectedAbs);
    expect(expectedAbs.startsWith('/')).toBe(true);

    // No registered command uses a leading '~' or a relative path.
    for (const c of cmds) {
      expect(c.startsWith('~')).toBe(false);
      expect(c.startsWith('/')).toBe(true);
    }

    // Unrelated PreToolUse entry survived untouched.
    expect(cmds).toContain('/usr/local/bin/user-audit.sh');

    // Unrelated settings preserved.
    expect(settings.permissions?.allow).toContain('Read(//etc/hosts)');
    expect(settings.someUnrelatedKey).toBe(42);
  });

  it('AC-A3 + idempotency: re-running install overwrites a stale hook and does not duplicate the registration', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // First install.
    const first = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(first.exitCode).toBe(0);

    const hp = hookPath(tmp.home);
    // Simulate an F1 zone rework / stale on-disk hook: overwrite the hook
    // with altered content that no longer matches the current template.
    writeFileSync(hp, '#!/bin/bash\n# STALE legacy .gan/ zone hook\nexit 0\n');
    expect(readFileSync(hp, 'utf8')).not.toBe(renderedTemplate());

    // Capture settings.json after first install for the byte-identical check.
    const settingsAfterFirst = readFileSync(settingsPath(tmp.home), 'utf8');

    // Second install.
    const second = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);

    // Hook regenerated to the current rendered template (no version-tracking
    // short-circuit skipped the overwrite).
    expect(readFileSync(hp, 'utf8')).toBe(renderedTemplate());

    // Exactly one framework PreToolUse entry references the hook path.
    const settings = readSettings(tmp.home);
    const matches = preToolUseCommands(settings).filter((c) => c === hp);
    expect(matches).toHaveLength(1);

    // Idempotent re-run: settings.json byte-identical to the first install.
    expect(readFileSync(settingsPath(tmp.home), 'utf8')).toBe(settingsAfterFirst);

    // No leftover .tmp.* siblings of the hook or settings.
    const hooksDir = path.dirname(hp);
    const claudeDir = path.dirname(settingsPath(tmp.home));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(hooksDir).filter((e) => e.includes('.tmp.'))).toEqual([]);
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Sprint 3: project-tier override warning (AC-A6 / AC-A7 / AC-M2).
  // -------------------------------------------------------------------------

  /** Path to the project-tier hook in a given repo (the cwd's `.claude/...`). */
  function projectHookPath(repo: string): string {
    return path.join(repo, '.claude', 'hooks', 'gan-confine.sh');
  }

  /**
   * The canonical override-warning sentence H1 § "Project-tier override
   * pattern" fixes. We assert semantic-exact presence of this line in install
   * output (the leading `log_info` prefix is empty, so the printed line equals
   * this string verbatim).
   */
  const CANONICAL_WARNING =
    'A project-tier confinement hook is present at `.claude/hooks/gan-confine.sh`. ' +
    "The framework's user-tier hook at `~/.claude/hooks/gan-confine.sh` will not be used " +
    "in this project. Verify the project hook still reflects the framework's current " +
    'zone layout (see F1).';

  // A short, stable substring of the canonical warning used as the
  // fires/does-not-fire probe (avoids brittle exact-whitespace coupling while
  // still being unique to the override warning).
  const WARNING_PROBE = 'A project-tier confinement hook is present at';

  it('AC-A6: with NO project-tier hook, install writes the user-tier hook + registration and the override warning does NOT fire', async () => {
    const { tmp, pathOverride, cwd } = setup();
    // Sanity: the repo (cwd) has no project-tier hook.
    expect(existsSync(projectHookPath(cwd))).toBe(false);

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // User-tier hook written + executable.
    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(statSync(hp).mode & 0o100).toBe(0o100);

    // Registered in settings.json PreToolUse with the absolute user-tier path.
    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    // Override warning absent from output (stdout + stderr).
    expect(result.stdout + result.stderr).not.toContain(WARNING_PROBE);
  });

  it('AC-A7: with a pre-seeded project-tier hook, install still writes only the user-tier hook + registration, never touches the project file, and the override warning FIRES', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // Pre-seed a project-tier hook in the cwd repo with sentinel content.
    const php = projectHookPath(cwd);
    mkdirSync(path.dirname(php), { recursive: true });
    const sentinel =
      '#!/bin/bash\n# PROJECT-TIER OVERRIDE — sentinel content, do not touch.\nexit 0\n';
    writeFileSync(php, sentinel);
    chmodSync(php, 0o755);
    const sentinelMtimeNs = statSync(php).mtimeMs;

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // (1) User-tier hook + registration written exactly as on a clean install.
    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(statSync(hp).mode & 0o100).toBe(0o100);
    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    // (2) Project-tier file is byte-identical and untouched (content + mtime).
    expect(readFileSync(php, 'utf8')).toBe(sentinel);
    expect(statSync(php).mtimeMs).toBe(sentinelMtimeNs);

    // (3) The override warning fired (probe present in install output).
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

    // Canonical text present verbatim (the four required elements + F1 ref).
    expect(out).toContain(CANONICAL_WARNING);

    // Required elements, checked individually so a partial drift is named.
    expect(out).toContain('`.claude/hooks/gan-confine.sh`');
    expect(out).toContain('`~/.claude/hooks/gan-confine.sh`');
    expect(out).toContain('will not be used in this project');
    expect(out).toContain("reflects the framework's current zone layout");
    expect(out).toContain('(see F1)');
    expect(out).toContain('the framework');
    expect(out).toContain('user-tier hook');

    // `gan hooks status` recommendation present and backtick-wrapped.
    expect(out).toContain('`gan hooks status`');

    // F4 prose discipline: isolate the emitted warning lines and assert no
    // bare runtime/package-manager token appears OUTSIDE backticks. We strip
    // every backtick-delimited span first, then scan the remainder.
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

    // Partial hook file removed.
    expect(existsSync(hookPath(tmp.home))).toBe(false);

    // settings.json was created by this run → removed entirely on rollback.
    expect(existsSync(settingsPath(tmp.home))).toBe(false);

    // No straggler temp / preedit files.
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

    // Pre-seed a settings.json so rollback must restore (not remove) it.
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

    // Partial hook removed.
    expect(existsSync(hookPath(tmp.home))).toBe(false);

    // settings.json byte-restored from the preedit snapshot — the framework
    // registration is gone, the user's content is exactly as it was.
    const post = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(post).toBe(preState);
    expect(preToolUseCommands(JSON.parse(post) as SettingsShape)).not.toContain(hookPath(tmp.home));

    // No straggler temp / preedit files.
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

    // Clean install first so the user-tier hook + registration exist.
    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    const hp = hookPath(tmp.home);
    expect(existsSync(hp)).toBe(true);
    expect(preToolUseCommands(readSettings(tmp.home))).toContain(hp);

    // Pre-seed an UNRELATED PreToolUse entry + an unrelated top-level key into
    // settings.json (a re-merge that keeps the framework entry intact).
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

    // Uninstall.
    const result = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // User-tier hook file gone.
    expect(existsSync(hp)).toBe(false);

    // Framework PreToolUse entry stripped; the unrelated entry + key survive.
    const after = readSettings(tmp.home);
    const cmds = preToolUseCommands(after);
    expect(cmds).not.toContain(hp);
    expect(cmds).toContain('/usr/local/bin/user-audit.sh');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

    // Output is valid sorted JSON with a trailing newline.
    const raw = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const reparsed = JSON.parse(raw) as SettingsShape;
    expect(JSON.stringify(reparsed)).toBeTruthy();
    // No straggler temp siblings.
    const claudeDir = path.dirname(settingsPath(tmp.home));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });

  it('does NOT touch a project-tier hook in the cwd, and is idempotent (second uninstall exits 0, removes nothing further)', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // Pre-seed a project-tier hook in the cwd repo.
    const php = path.join(cwd, '.claude', 'hooks', 'gan-confine.sh');
    mkdirSync(path.dirname(php), { recursive: true });
    const sentinel = '#!/bin/bash\n# PROJECT OVERRIDE sentinel.\nexit 0\n';
    writeFileSync(php, sentinel);

    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(true);

    // First uninstall.
    const first = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(first.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(false);
    // Project-tier hook untouched.
    expect(readFileSync(php, 'utf8')).toBe(sentinel);

    // Second uninstall against the now-clean HOME exits 0 and is a no-op.
    const second = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);
    expect(existsSync(hookPath(tmp.home))).toBe(false);
    // Project-tier hook STILL untouched after the idempotent re-run.
    expect(readFileSync(php, 'utf8')).toBe(sentinel);
  });

  it('preserves unrelated settings end-to-end: an adversarial near-miss command + user permissions.allow survive the strip', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const installed = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(installed.exitCode).toBe(0);
    const hp = hookPath(tmp.home);

    // Craft settings.json that, alongside the real framework entry, carries an
    // adversarial near-miss: a PreToolUse entry whose command merely CONTAINS
    // the hook path as a substring (with a prefix), plus a user permissions
    // entry. A correct structural (command === hookAbs) match must NOT delete
    // these.
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
    // The exact framework entry is gone.
    expect(cmds).not.toContain(hp);
    // The near-miss commands (substring / suffixed) survive — only the exact
    // path match is stripped, never substring matches.
    expect(cmds).toContain(`/opt/wrap ${hp}`);
    expect(cmds).toContain(`${hp}.bak`);
    // User permissions.allow entries that are NOT framework-catalog tools
    // survive the permissions strip too.
    expect(after.permissions?.allow).toContain('Read(//etc/hosts)');
  });

  it('survives an adversarial repo path containing shell metacharacters without command injection (detection is read-only + quoted)', async () => {
    // A repo directory whose name carries `$()`, `;`, backticks and a space.
    // If the detection helper interpolated the path into a command, this would
    // execute the injected fragment; the double-quoted `[ -f ]` test treats it
    // purely as data. We assert install completes cleanly and the project-tier
    // warning still fires from inside this hostile cwd.
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

    // Build the hostile git repo under tmp.root.
    const hostileRepo = path.join(tmp.root, 'evil $(touch PWNED);` ` repo');
    mkdirSync(hostileRepo, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['init', '--quiet', hostileRepo], { stdio: 'ignore' }).status).toBe(0);
    const php = path.join(hostileRepo, '.claude', 'hooks', 'gan-confine.sh');
    mkdirSync(path.dirname(php), { recursive: true });
    writeFileSync(php, '#!/bin/bash\nexit 0\n');

    const result = await runInstall([], { home: tmp.home, pathOverride: tmp.bin, cwd: hostileRepo });
    expect(result.exitCode).toBe(0);
    // No injected side-effect file was created anywhere we can observe.
    expect(existsSync(path.join(hostileRepo, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);
    // The warning still fires for the hostile-named repo's project hook.
    expect(result.stdout).toContain('A project-tier confinement hook is present at');
    // And the project-tier file is byte-untouched.
    expect(readFileSync(php, 'utf8')).toBe('#!/bin/bash\nexit 0\n');
  });
});

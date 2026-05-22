/**
 * F7 slice 5 — install-time central run-data store configuration.
 *
 * `install.sh` learns a `--runs-dir=<path>` flag (and, in interactive installs,
 * a prompt defaulting to `~/.gan-runs-data`). For the resolved store root it
 * performs two STATE_LOG-tracked writes:
 *   1. persists the path to the user-tier marker `~/.claude/gan/runs-data-dir`
 *      as a single trimmed raw-path line (the exact format slice-1's
 *      resolveStoreRoot() reads); and
 *   2. grants persistent read/write by merging `permissions.allow` rules
 *      Read/Write/Edit(<store-root>/**) plus a `permissions.additionalDirectories`
 *      entry for <store-root> into `~/.claude/settings.json`.
 * `--uninstall` removes both; a partial-failure rollback removes both.
 *
 * Every invocation runs against a sandboxed `$HOME` (makeTmpHome) so the
 * developer's real `~/.claude/` is never touched. The resolver tie-in is
 * checked by importing the shipped slice-1 `resolveStoreRoot` and pointing its
 * `homedir` seam at the sandbox HOME the installer just wrote into.
 *
 * Covers the sprint-5 contract criteria:
 *   - runs_dir_flag_persists_marker
 *   - marker_is_value_resolver_reads
 *   - interactive_prompt_defaults_to_default_dir (non-TTY half + prompt text)
 *   - settings_grant_allow_rules_and_additional_directory
 *   - state_log_entries_recorded
 *   - uninstall_removes_marker_and_settings_grant
 *   - rollback_removes_marker_and_settings_grant
 *   - runs_dir_value_quoted_no_injection
 *   - no_secret_or_home_literal_committed (static, at the bottom)
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir, installScriptPath } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeNpm, writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';
import { injectFailureAt, makeFailureEnv } from './helpers/failurePoints.js';
import {
  resolveStoreRoot,
  STORE_MARKER_RELPATH,
  DEFAULT_STORE_DIRNAME,
} from '../../src/config-server/storage/run-store.js';

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

/**
 * Happy-path setup: stub node delegating to the real interpreter for `-e`/`-p`,
 * git, claude, npm, and a config-server reporting the running package version so
 * `install_mcp_server` is skipped (keeps the run light).
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
  writeFakeConfigServer(tmp.bin, { version: packageVersion() });
  return { tmp, pathOverride: tmp.bin, cwd: tmp.repo!, npmLog };
}

function markerPath(home: string): string {
  return path.join(home, STORE_MARKER_RELPATH);
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

interface SettingsShape {
  permissions?: { allow?: unknown[]; additionalDirectories?: unknown[] };
  [k: string]: unknown;
}

function readSettings(home: string): SettingsShape {
  return JSON.parse(readFileSync(settingsPath(home), 'utf8')) as SettingsShape;
}

describe('install.sh --runs-dir — marker persistence + resolver tie-in', () => {
  it('runs_dir_flag_persists_marker: writes the marker as a single trimmed raw-path line equal to the supplied path', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'central-store');

    const result = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const mp = markerPath(tmp.home);
    expect(existsSync(mp)).toBe(true);
    // Raw path, NOT JSON — trimming yields exactly the supplied path.
    const raw = readFileSync(mp, 'utf8');
    expect(raw.trim()).toBe(runsDir);
    expect(() => JSON.parse(raw)).toThrow();
  });

  it('marker_is_value_resolver_reads: slice-1 resolveStoreRoot reads exactly the persisted marker; env overrides; removal falls back to default', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'resolver-store');

    const result = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const homedir = () => tmp.home;

    // Precedence step 2: marker contents (no GAN_RUNS_DATA set).
    expect(resolveStoreRoot({ homedir, env: {} })).toBe(path.normalize(runsDir));

    // Precedence step 1: GAN_RUNS_DATA overrides the marker.
    const other = path.join(tmp.root, 'env-override');
    expect(resolveStoreRoot({ homedir, env: { GAN_RUNS_DATA: other } })).toBe(path.normalize(other));

    // Precedence step 3: with the marker removed, fall back to the default.
    const { rmSync } = await import('node:fs');
    rmSync(markerPath(tmp.home));
    expect(resolveStoreRoot({ homedir, env: {} })).toBe(
      path.join(tmp.home, DEFAULT_STORE_DIRNAME),
    );
  });

  it('interactive_prompt_defaults_to_default_dir (non-TTY): no flag → no prompt, marker persists the `~/.gan-runs-data` default expanded against HOME', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // Non-TTY harness run (stdin is 'ignore') with no flag.
    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // No interactive prompt emitted in non-TTY mode.
    expect(result.stdout).not.toContain('Store root [');

    // Marker persists the default, expanded to the sandbox HOME (no literal `~`).
    const expectedDefault = path.join(tmp.home, DEFAULT_STORE_DIRNAME);
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(expectedDefault);
    expect(resolveStoreRoot({ homedir: () => tmp.home, env: {} })).toBe(expectedDefault);
  });

  it('interactive_prompt_defaults_to_default_dir (TTY prompt branch): the prompt names `~/.gan-runs-data` as the default and an empty answer (Enter) selects it', async () => {
    // A real PTY is fragile inside the vitest harness (the existing suite
    // documents that interactive TTY UX needs a pty and is exercised by
    // live-install.sh, not here). Instead we exercise install.sh's actual
    // prompt branch deterministically: source install.sh with `main "$@"`
    // stripped AND the interactive-branch guard `[ -t 0 ]` forced true, then
    // feed an empty line (the Enter the user would press) on stdin. The driver
    // dumps both the emitted prompt text and the resolved RUNS_DIR. This runs
    // the SAME prompt/`read`/default-selection code the TTY install runs — only
    // the stdin-is-a-TTY guard is forced, not the prompt logic.
    const { tmp } = setup();

    const installRaw = readFileSync(installScriptPath(), 'utf8');
    let trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');
    // Force the prompt branch: replace the single `elif [ -t 0 ]; then` guard
    // inside resolve_runs_dir with `elif true; then`. The token is unique to
    // resolve_runs_dir (configure_permissions uses `elif [ ! -t 0 ]`).
    const guard = 'elif [ -t 0 ]; then';
    expect(trimmed).toContain(guard);
    trimmed = trimmed.replace(guard, 'elif true; then');

    const trimmedPath = path.join(tmp.root, 'install-no-main-tty.sh');
    writeFileSync(trimmedPath, trimmed);

    const driver = path.join(tmp.root, 'tty-driver.sh');
    writeFileSync(
      driver,
      [
        `#!/usr/bin/env bash`,
        `set -uo pipefail`,
        `# shellcheck disable=SC1090`,
        `source ${JSON.stringify(trimmedPath)}`,
        `RUNS_DIR_FLAG=""`,
        // Empty stdin line = pressing Enter at the prompt.
        `printf '\\n' | { resolve_runs_dir; printf 'RESOLVED=%s\\n' "$RUNS_DIR"; }`,
      ].join('\n'),
      { mode: 0o755 },
    );

    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('/bin/bash', [driver], {
      env: { ...process.env, HOME: tmp.home },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    // The prompt names the tilde default.
    expect(result.stdout).toMatch(/Store root \[~\/\.gan-runs-data\]:/);

    // The empty answer selected the default, expanded against HOME.
    const expectedDefault = path.join(tmp.home, DEFAULT_STORE_DIRNAME);
    expect(result.stdout).toContain(`RESOLVED=${expectedDefault}`);
  });
});

describe('install.sh --runs-dir — settings.json read/write grant', () => {
  it('settings_grant_allow_rules_and_additional_directory: adds the 3 allow rules + additionalDirectories entry, additive, idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'grant-store');

    // Pre-seed settings.json with an unrelated permissions.allow entry, an
    // unrelated additionalDirectories entry, and an unrelated top-level key.
    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    const preExisting = {
      permissions: {
        allow: ['Read(//etc/hosts)'],
        additionalDirectories: ['/opt/some-user-dir'],
      },
      someUnrelatedKey: 7,
    };
    writeFileSync(settingsPath(tmp.home), JSON.stringify(preExisting, null, 2) + '\n');

    const r1 = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(r1.exitCode).toBe(0);

    const settings = readSettings(tmp.home);
    const allow = (settings.permissions?.allow ?? []).map(String);
    const addl = (settings.permissions?.additionalDirectories ?? []).map(String);

    // The three RW rules scoped to the store-root subtree.
    expect(allow).toContain(`Read(${runsDir}/**)`);
    expect(allow).toContain(`Write(${runsDir}/**)`);
    expect(allow).toContain(`Edit(${runsDir}/**)`);
    // The additionalDirectories entry equals the store root exactly.
    expect(addl).toContain(runsDir);

    // Additive: unrelated entries + top-level key survive.
    expect(allow).toContain('Read(//etc/hosts)');
    expect(addl).toContain('/opt/some-user-dir');
    expect(settings.someUnrelatedKey).toBe(7);

    // Sorted-key, 2-space-indent, trailing-newline JSON, no straggler tmp.
    const raw1 = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw1.endsWith('\n')).toBe(true);
    const claudeDir = path.dirname(settingsPath(tmp.home));
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);

    // Idempotent: a second install adds no duplicate and is byte-identical.
    const r2 = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);
    const raw2 = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw2).toBe(raw1);
    // Exactly one of each rule.
    const allow2 = (readSettings(tmp.home).permissions?.allow ?? []).map(String);
    expect(allow2.filter((a) => a === `Read(${runsDir}/**)`)).toHaveLength(1);
    expect(allow2.filter((a) => a === `Write(${runsDir}/**)`)).toHaveLength(1);
    expect(allow2.filter((a) => a === `Edit(${runsDir}/**)`)).toHaveLength(1);
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });
});

describe('install.sh --runs-dir — STATE_LOG (function-level)', () => {
  it('state_log_entries_recorded: configure_runs_dir records runs-dir-configured then runs-dir-permission-granted, after a claude-settings-edited snapshot', async () => {
    // Source install.sh with `main "$@"` stripped (as rollback.test.ts does),
    // then drive resolve_runs_dir + the settings preedit + configure_runs_dir
    // directly and dump STATE_LOG so we can assert the entries and their order.
    const { tmp } = setup();
    const runsDir = path.join(tmp.root, 'state-log-store');

    const installRaw = readFileSync(installScriptPath(), 'utf8');
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
        // The settings preedit snapshot is normally taken by an earlier step;
        // take it here so configure_runs_dir's grant rides the existing
        // claude-settings-edited rollback case (the criterion asserts this).
        `ensure_settings_preedit_snapshot`,
        `RUNS_DIR_FLAG=${JSON.stringify(runsDir)}`,
        `resolve_runs_dir`,
        `configure_runs_dir`,
        `printf '%s\\n' "\${STATE_LOG[@]}"`,
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

    const lines = result.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain(`runs-dir-configured:${runsDir}`);
    expect(lines).toContain(`runs-dir-permission-granted:${runsDir}`);

    // Order: configured before permission-granted.
    const idxConfigured = lines.indexOf(`runs-dir-configured:${runsDir}`);
    const idxGranted = lines.indexOf(`runs-dir-permission-granted:${runsDir}`);
    expect(idxConfigured).toBeLessThan(idxGranted);

    // A claude-settings-edited snapshot was recorded before the grant.
    const idxSnapshot = lines.findIndex((l) => l.startsWith('claude-settings-edited:'));
    expect(idxSnapshot).toBeGreaterThanOrEqual(0);
    expect(idxSnapshot).toBeLessThan(idxGranted);
  });
});

describe('install.sh --uninstall — removes marker + settings grant', () => {
  it('uninstall_removes_marker_and_settings_grant: strips the 3 rules + additionalDirectories entry + marker; unrelated entries survive; idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'uninstall-store');

    // Pre-seed unrelated entries we must preserve.
    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    writeFileSync(
      settingsPath(tmp.home),
      JSON.stringify(
        {
          permissions: {
            allow: ['Read(//etc/hosts)'],
            additionalDirectories: ['/opt/keep-me'],
          },
          keepMe: 'survivor',
        },
        null,
        2,
      ) + '\n',
    );

    const installed = await runInstall([`--runs-dir=${runsDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(installed.exitCode).toBe(0);
    expect(existsSync(markerPath(tmp.home))).toBe(true);

    const result = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // Marker gone.
    expect(existsSync(markerPath(tmp.home))).toBe(false);

    // The three store-root rules + the store-root additionalDirectories entry gone.
    const after = readSettings(tmp.home);
    const allow = (after.permissions?.allow ?? []).map(String);
    const addl = (after.permissions?.additionalDirectories ?? []).map(String);
    expect(allow).not.toContain(`Read(${runsDir}/**)`);
    expect(allow).not.toContain(`Write(${runsDir}/**)`);
    expect(allow).not.toContain(`Edit(${runsDir}/**)`);
    expect(addl).not.toContain(runsDir);

    // Unrelated entries + top-level key survive.
    expect(allow).toContain('Read(//etc/hosts)');
    expect(addl).toContain('/opt/keep-me');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

    // Idempotent: a second uninstall against the now-clean HOME exits 0 and
    // removes nothing further.
    const second = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);
    expect(existsSync(markerPath(tmp.home))).toBe(false);
    const after2 = readSettings(tmp.home);
    expect((after2.permissions?.allow ?? []).map(String)).toContain('Read(//etc/hosts)');
    expect((after2.permissions?.additionalDirectories ?? []).map(String)).toContain('/opt/keep-me');
  });
});

describe('install.sh --runs-dir — partial-failure rollback', () => {
  it('rollback_removes_marker_and_settings_grant (no pre-existing settings.json): exit non-zero, marker absent, settings.json absent, no stragglers', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'rollback-store-new');

    const env = makeFailureEnv();
    injectFailureAt(env, 'runs-dir-config');

    const result = await runInstall([`--runs-dir=${runsDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    // Marker removed (the run created it).
    expect(existsSync(markerPath(tmp.home))).toBe(false);
    // settings.json was created by this run → removed entirely on rollback.
    expect(existsSync(settingsPath(tmp.home))).toBe(false);

    // No straggler tmp/preedit files for the marker or settings.
    const ganDir = path.join(tmp.home, '.claude', 'gan');
    if (existsSync(ganDir)) {
      expect(
        readdirSync(ganDir).filter(
          (e) => e.startsWith('runs-data-dir.tmp.') || e.startsWith('runs-data-dir.preedit-'),
        ),
      ).toEqual([]);
    }
    const claudeDir = path.join(tmp.home, '.claude');
    if (existsSync(claudeDir)) {
      expect(
        readdirSync(claudeDir).filter(
          (e) => e.startsWith('settings.json.tmp.') || e.startsWith('settings.json.preedit-'),
        ),
      ).toEqual([]);
    }
  });

  it('rollback_removes_marker_and_settings_grant (pre-seeded settings.json): byte-restored, store-root rules gone', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'rollback-store-existing');

    // Pre-seed a settings.json so rollback must byte-restore (not remove) it.
    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    const preState =
      JSON.stringify(
        {
          permissions: { allow: ['Read(//tmp/x)'], additionalDirectories: ['/opt/pre'] },
        },
        ['permissions'],
        2,
      ) + '\n';
    writeFileSync(settingsPath(tmp.home), preState);

    const env = makeFailureEnv();
    injectFailureAt(env, 'runs-dir-config');

    const result = await runInstall([`--runs-dir=${runsDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    // Marker removed.
    expect(existsSync(markerPath(tmp.home))).toBe(false);

    // settings.json byte-restored from the preedit snapshot — the grant is gone.
    const post = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(post).toBe(preState);
    const allow = (JSON.parse(post) as SettingsShape).permissions?.allow ?? [];
    expect(allow.map(String)).not.toContain(`Read(${runsDir}/**)`);

    // No straggler tmp/preedit files.
    const claudeDir = path.join(tmp.home, '.claude');
    expect(
      readdirSync(claudeDir).filter(
        (e) => e.startsWith('settings.json.tmp.') || e.startsWith('settings.json.preedit-'),
      ),
    ).toEqual([]);
    const ganDir = path.join(tmp.home, '.claude', 'gan');
    if (existsSync(ganDir)) {
      expect(
        readdirSync(ganDir).filter(
          (e) => e.startsWith('runs-data-dir.tmp.') || e.startsWith('runs-data-dir.preedit-'),
        ),
      ).toEqual([]);
    }
  });
});

describe('install.sh --runs-dir — shell/subprocess safety (no injection)', () => {
  it('runs_dir_value_quoted_no_injection: a hostile path with shell metacharacters installs cleanly, persists literally, and creates no injected side-effect', async () => {
    const { tmp, pathOverride, cwd } = setup();
    // A store-root path carrying `$(...)`, `;`, backticks and a space. If the
    // value were interpolated into a shell/eval string or the node program text,
    // the `touch PWNED` fragment would run; quoting + env-as-DATA treat it as a
    // literal path.
    const hostile = path.join(tmp.root, 'evil $(touch PWNED);` ` store');

    const result = await runInstall([`--runs-dir=${hostile}`], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // No injected side-effect file anywhere observable.
    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(cwd, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.home, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(repoRootDir(), 'PWNED'))).toBe(false);

    // The marker contains the literal path byte-for-byte (single trimmed line).
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(hostile);

    // settings.json carries the literal path in the allow rules + additionalDirectories.
    const settings = readSettings(tmp.home);
    const allow = (settings.permissions?.allow ?? []).map(String);
    const addl = (settings.permissions?.additionalDirectories ?? []).map(String);
    expect(allow).toContain(`Read(${hostile}/**)`);
    expect(allow).toContain(`Write(${hostile}/**)`);
    expect(allow).toContain(`Edit(${hostile}/**)`);
    expect(addl).toContain(hostile);

    // The resolver reads back exactly the literal path.
    expect(resolveStoreRoot({ homedir: () => tmp.home, env: {} })).toBe(path.normalize(hostile));
  });

  it('no `eval` command and every store-root value expansion in install.sh is double-quoted', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');
    // Code lines only: drop the comment portion of each line so prose like
    // "no `eval`" / "evaluator" / variable names mentioned in comments is
    // ignored. (A `#` inside a quoted string is rare here and the lines that
    // matter — the value expansions — carry no inline `#`.)
    const codeLines = installRaw.split('\n').map((l) => l.replace(/#.*$/, ''));

    // Static: no actual `eval` COMMAND is invoked (start of statement: line
    // start or after `;`, `&&`, `||`, `|`).
    for (const code of codeLines) {
      expect(code).not.toMatch(/(^|[;&|]\s*)\beval\b/);
    }

    // The untrusted store-root value flows through three shell variables:
    // $RUNS_DIR, $RUNS_DIR_FLAG, $granted_store_root. Every EXPANSION of each
    // must occur inside a double-quoted span (so word-splitting / glob /
    // injection cannot fire). We track double-quote state per character —
    // honouring single-quoted spans (where `"` and `$` are literal) — and, for
    // each `$<value-var>` expansion, assert the cursor is inside a double quote.
    const valueVarRe = /^(RUNS_DIR|RUNS_DIR_FLAG|granted_store_root)(?![A-Za-z0-9_])/;
    for (const code of codeLines) {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === "'" && !inDouble) {
          inSingle = !inSingle;
          continue;
        }
        if (ch === '"' && !inSingle) {
          inDouble = !inDouble;
          continue;
        }
        if (ch === '$' && !inSingle) {
          const rest = code.slice(i + 1);
          if (valueVarRe.test(rest)) {
            // An expansion of a value var: it MUST be inside a double-quoted
            // span. (Single-quoted `$` is literal and handled by `!inSingle`.)
            expect(inDouble).toBe(true);
          }
        }
      }
    }
  });
});

describe('install.sh --runs-dir — no committed secret/home literal (static)', () => {
  it('no_secret_or_home_literal_committed: the new install.sh/test code carries no absolute home/store literal — only the `~/.gan-runs-data` tilde default and runtime-derived values', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');
    const thisTestRaw = readFileSync(
      path.join(repoRootDir(), 'tests', 'installer', 'runsDir.test.ts'),
      'utf8',
    );
    for (const src of [installRaw, thisTestRaw]) {
      // No developer-home absolute path literals baked in.
      expect(src).not.toMatch(/\/Users\/[a-z]/i);
      expect(src).not.toMatch(/\/home\/[a-z]/i);
    }
    // The only store-path default literal in install.sh is the tilde form.
    expect(installRaw).toContain('~/.gan-runs-data');
    expect(installRaw).toContain('$HOME/.gan-runs-data');
  });
});

/**
 * Coverage for the `--runs-dir` install option: persisting a store-root marker
 * AND granting Claude Code permission to that directory in settings.json.
 *
 * What this verifies:
 * - The flag writes the marker as a single trimmed RAW-PATH line (not JSON);
 *   `resolveStoreRoot` reads exactly it; `GAN_RUNS_DATA` env overrides it;
 *   removing the marker falls back to the `~/.gan-runs-data` default.
 * - Non-TTY: no flag means no prompt, the default is persisted. TTY branch
 *   (sourced, main-stripped install.sh with the `-t 0` guard rewritten) names
 *   `~/.gan-runs-data` and an empty Enter selects it.
 * - settings.json grant: adds three allow rules (Read/Write/Edit on
 *   `<runsDir>/**`) plus an additionalDirectories entry, ADDITIVELY (unrelated
 *   user entries survive) and IDEMPOTENTLY (a re-run is byte-stable, no
 *   duplicates).
 * - STATE_LOG ordering: `runs-dir-configured` precedes
 *   `runs-dir-permission-granted`, and a `claude-settings-edited` preedit
 *   snapshot is logged before the grant (so rollback can restore it).
 * - `--uninstall` strips the three rules + additionalDirectories entry + marker
 *   while preserving unrelated entries; idempotent.
 * - Partial-failure rollback: removes a new marker / byte-restores settings.json
 *   (rules gone) with no tmp/preedit stragglers.
 * - Shell-injection safety + no committed home/store literal (same static gates
 *   as the module-state suite).
 *
 * What it guards (WHY): unlike module-state, the runs dir DOES get an explicit
 * Claude Code permission grant (this is the F8 "parity-PLUS"); that grant must
 * be additive, idempotent, fully reversible, and snapshot-before-edit so a
 * partial failure restores the user's settings byte-for-byte. The driver
 * scripts and `# shellcheck` lines are DATA inside string literals.
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

    const raw = readFileSync(mp, 'utf8');
    expect(raw.trim()).toBe(runsDir);
    // Bare-path marker, not JSON: a parseable JSON body would mean the format
    // regressed away from what the simple line-reading resolver expects.
    expect(() => JSON.parse(raw)).toThrow();
  });

  it('marker_is_value_resolver_reads: slice-1 resolveStoreRoot reads exactly the persisted marker; env overrides; removal falls back to default', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'resolver-store');

    const result = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    const homedir = () => tmp.home;

    expect(resolveStoreRoot({ homedir, env: {} })).toBe(path.normalize(runsDir));

    const other = path.join(tmp.root, 'env-override');
    expect(resolveStoreRoot({ homedir, env: { GAN_RUNS_DATA: other } })).toBe(path.normalize(other));

    const { rmSync } = await import('node:fs');
    rmSync(markerPath(tmp.home));
    expect(resolveStoreRoot({ homedir, env: {} })).toBe(
      path.join(tmp.home, DEFAULT_STORE_DIRNAME),
    );
  });

  it('interactive_prompt_defaults_to_default_dir (non-TTY): no flag → no prompt, marker persists the `~/.gan-runs-data` default expanded against HOME', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(result.stdout).not.toContain('Store root [');

    const expectedDefault = path.join(tmp.home, DEFAULT_STORE_DIRNAME);
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(expectedDefault);
    expect(resolveStoreRoot({ homedir: () => tmp.home, env: {} })).toBe(expectedDefault);
  });

  it('interactive_prompt_defaults_to_default_dir (TTY prompt branch): the prompt names `~/.gan-runs-data` as the default and an empty answer (Enter) selects it', async () => {

    const { tmp } = setup();

    // Strip `main "$@"` so the script can be sourced for function isolation,
    // then force the prompt branch by rewriting the TTY guard (`[ -t 0 ]`,
    // false under the test harness) to an always-true condition.
    const installRaw = readFileSync(installScriptPath(), 'utf8');
    let trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');

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

    expect(result.stdout).toMatch(/Store root \[~\/\.gan-runs-data\]:/);

    const expectedDefault = path.join(tmp.home, DEFAULT_STORE_DIRNAME);
    expect(result.stdout).toContain(`RESOLVED=${expectedDefault}`);
  });
});

describe('install.sh --runs-dir — settings.json read/write grant', () => {
  it('settings_grant_allow_rules_and_additional_directory: adds the 3 allow rules + additionalDirectories entry, additive, idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'grant-store');

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

    expect(allow).toContain(`Read(${runsDir}/**)`);
    expect(allow).toContain(`Write(${runsDir}/**)`);
    expect(allow).toContain(`Edit(${runsDir}/**)`);

    expect(addl).toContain(runsDir);

    expect(allow).toContain('Read(//etc/hosts)');
    expect(addl).toContain('/opt/some-user-dir');
    expect(settings.someUnrelatedKey).toBe(7);

    const raw1 = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw1.endsWith('\n')).toBe(true);
    const claudeDir = path.dirname(settingsPath(tmp.home));
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);

    const r2 = await runInstall([`--runs-dir=${runsDir}`], { home: tmp.home, pathOverride, cwd });
    expect(r2.exitCode).toBe(0);
    const raw2 = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(raw2).toBe(raw1);

    const allow2 = (readSettings(tmp.home).permissions?.allow ?? []).map(String);
    expect(allow2.filter((a) => a === `Read(${runsDir}/**)`)).toHaveLength(1);
    expect(allow2.filter((a) => a === `Write(${runsDir}/**)`)).toHaveLength(1);
    expect(allow2.filter((a) => a === `Edit(${runsDir}/**)`)).toHaveLength(1);
    expect(readdirSync(claudeDir).filter((e) => e.includes('settings.json.tmp.'))).toEqual([]);
  });
});

describe('install.sh --runs-dir — STATE_LOG (function-level)', () => {
  it('state_log_entries_recorded: configure_runs_dir records runs-dir-configured then runs-dir-permission-granted, after a claude-settings-edited snapshot', async () => {

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

    // Ordering matters for rollback: the marker must be configured before the
    // permission is granted, and the settings preedit snapshot must be taken
    // before the grant edits settings.json — otherwise a failure couldn't
    // restore the file. Assert both happens-before relationships via log index.
    const idxConfigured = lines.indexOf(`runs-dir-configured:${runsDir}`);
    const idxGranted = lines.indexOf(`runs-dir-permission-granted:${runsDir}`);
    expect(idxConfigured).toBeLessThan(idxGranted);

    const idxSnapshot = lines.findIndex((l) => l.startsWith('claude-settings-edited:'));
    expect(idxSnapshot).toBeGreaterThanOrEqual(0);
    expect(idxSnapshot).toBeLessThan(idxGranted);
  });
});

describe('install.sh --uninstall — removes marker + settings grant', () => {
  it('uninstall_removes_marker_and_settings_grant: strips the 3 rules + additionalDirectories entry + marker; unrelated entries survive; idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const runsDir = path.join(tmp.root, 'uninstall-store');

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

    expect(existsSync(markerPath(tmp.home))).toBe(false);

    const after = readSettings(tmp.home);
    const allow = (after.permissions?.allow ?? []).map(String);
    const addl = (after.permissions?.additionalDirectories ?? []).map(String);
    expect(allow).not.toContain(`Read(${runsDir}/**)`);
    expect(allow).not.toContain(`Write(${runsDir}/**)`);
    expect(allow).not.toContain(`Edit(${runsDir}/**)`);
    expect(addl).not.toContain(runsDir);

    expect(allow).toContain('Read(//etc/hosts)');
    expect(addl).toContain('/opt/keep-me');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

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

    expect(existsSync(markerPath(tmp.home))).toBe(false);

    expect(existsSync(settingsPath(tmp.home))).toBe(false);

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

    expect(existsSync(markerPath(tmp.home))).toBe(false);

    const post = readFileSync(settingsPath(tmp.home), 'utf8');
    expect(post).toBe(preState);
    const allow = (JSON.parse(post) as SettingsShape).permissions?.allow ?? [];
    expect(allow.map(String)).not.toContain(`Read(${runsDir}/**)`);

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

    const hostile = path.join(tmp.root, 'evil $(touch PWNED);` ` store');

    const result = await runInstall([`--runs-dir=${hostile}`], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(cwd, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.home, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(repoRootDir(), 'PWNED'))).toBe(false);

    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(hostile);

    const settings = readSettings(tmp.home);
    const allow = (settings.permissions?.allow ?? []).map(String);
    const addl = (settings.permissions?.additionalDirectories ?? []).map(String);
    expect(allow).toContain(`Read(${hostile}/**)`);
    expect(allow).toContain(`Write(${hostile}/**)`);
    expect(allow).toContain(`Edit(${hostile}/**)`);
    expect(addl).toContain(hostile);

    expect(resolveStoreRoot({ homedir: () => tmp.home, env: {} })).toBe(path.normalize(hostile));
  });

  it('no `eval` command and every store-root value expansion in install.sh is double-quoted', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');

    const codeLines = installRaw.split('\n').map((l) => l.replace(/#.*$/, ''));

    for (const code of codeLines) {
      expect(code).not.toMatch(/(^|[;&|]\s*)\beval\b/);
    }

    // Quote state machine over each comment-stripped line: track single/double
    // quote nesting and, at every `$` that starts one of the store-root value
    // variables, require it to be inside double quotes — an unquoted expansion
    // of an attacker-controlled path is the injection vector this forbids.
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

      expect(src).not.toMatch(/\/Users\/[a-z]/i);
      expect(src).not.toMatch(/\/home\/[a-z]/i);
    }

    expect(installRaw).toContain('~/.gan-runs-data');
    expect(installRaw).toContain('$HOME/.gan-runs-data');
  });
});

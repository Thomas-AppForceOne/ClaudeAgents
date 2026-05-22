/**
 * F8 — install-time central module-state store configuration.
 *
 * `install.sh` learns a `--module-state-dir=<path>` flag (and, in interactive
 * installs, a prompt defaulting to `~/.gan-module-state`). For the resolved
 * store root it performs ONE STATE_LOG-tracked write:
 *   1. persists the path to the user-tier marker `~/.claude/gan/module-state-dir`
 *      as a single trimmed raw-path line (the exact format Sprint 1's
 *      resolveModuleStateRoot() reads).
 *
 * THE F8 PARITY-MINUS vs F7's `--runs-dir`: there is NO settings.json grant.
 * Module state is config-server-managed (the server process writes it directly;
 * no Claude-tool file operation reaches it), so F8 adds NO `permissions.allow`
 * rule and NO `additionalDirectories` entry for the module store (F8 §4). These
 * tests assert that absence explicitly — the load-bearing F8/F7 distinction.
 *
 * `--uninstall` removes the marker (marker-only — no settings strip); a
 * partial-failure rollback removes/byte-restores the marker.
 *
 * Every invocation runs against a sandboxed `$HOME` (makeTmpHome) so the
 * developer's real `~/.claude/` is never touched. The resolver tie-in is
 * checked by importing the shipped Sprint 1 `resolveModuleStateRoot` and
 * pointing its `homedir` seam at the sandbox HOME the installer just wrote into.
 *
 * Mirrors tests/installer/runsDir.test.ts (the directly-analogous `--runs-dir`
 * suite), ADDING the no-settings-grant assertion and DROPPING the
 * settings-grant describe blocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir, installScriptPath } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeNpm, writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';
import { injectFailureAt, makeFailureEnv } from './helpers/failurePoints.js';
import {
  resolveModuleStateRoot,
  MODULE_STATE_MARKER_RELPATH,
  DEFAULT_MODULE_STATE_DIRNAME,
} from '../../src/config-server/storage/module-state-store.js';

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
 * `install_mcp_server` is skipped (keeps the run light). Identical to
 * runsDir.test.ts's setup().
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
  return path.join(home, MODULE_STATE_MARKER_RELPATH);
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

/**
 * Assert no settings.json entry — `permissions.allow` rule or
 * `additionalDirectories` member — references the given module-state root.
 * Tolerates an absent settings.json (the non-pre-seeded case). This is the
 * F8-specific assertion absent from the `--runs-dir` suite.
 */
function expectNoModuleStateGrant(home: string, moduleStateRoot: string): void {
  if (!existsSync(settingsPath(home))) {
    // No settings.json at all → trivially no grant. (Module state never creates
    // settings.json — only the marker.)
    return;
  }
  const settings = readSettings(home);
  const allow = (settings.permissions?.allow ?? []).map(String);
  const addl = (settings.permissions?.additionalDirectories ?? []).map(String);
  // No store-root-scoped Read/Write/Edit rule.
  expect(allow).not.toContain(`Read(${moduleStateRoot}/**)`);
  expect(allow).not.toContain(`Write(${moduleStateRoot}/**)`);
  expect(allow).not.toContain(`Edit(${moduleStateRoot}/**)`);
  // No allow rule and no additionalDirectories entry references the root at all.
  expect(allow.some((a) => a.includes(moduleStateRoot))).toBe(false);
  expect(addl).not.toContain(moduleStateRoot);
  expect(addl.some((d) => d.includes(moduleStateRoot))).toBe(false);
}

describe('install.sh --module-state-dir — marker persistence + resolver tie-in', () => {
  it('module_state_dir_flag_persists_marker: writes the marker as a single trimmed raw-path line equal to the supplied path', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'module-store');

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const mp = markerPath(tmp.home);
    expect(existsSync(mp)).toBe(true);
    // Raw path, NOT JSON — trimming yields exactly the supplied path.
    const raw = readFileSync(mp, 'utf8');
    expect(raw.trim()).toBe(moduleStateDir);
    expect(() => JSON.parse(raw)).toThrow();
  });

  it('marker_is_value_resolver_reads: Sprint-1 resolveModuleStateRoot reads exactly the persisted marker; env overrides; removal falls back to default', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'resolver-module-store');

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    const homedir = () => tmp.home;

    // Precedence step 2: marker contents (no GAN_MODULE_STATE set).
    expect(resolveModuleStateRoot({ homedir, env: {} })).toBe(path.normalize(moduleStateDir));

    // Precedence step 1: GAN_MODULE_STATE overrides the marker.
    const other = path.join(tmp.root, 'env-override-module');
    expect(resolveModuleStateRoot({ homedir, env: { GAN_MODULE_STATE: other } })).toBe(
      path.normalize(other),
    );

    // Precedence step 3: with the marker removed, fall back to the default.
    const { rmSync } = await import('node:fs');
    rmSync(markerPath(tmp.home));
    expect(resolveModuleStateRoot({ homedir, env: {} })).toBe(
      path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME),
    );
  });

  it('interactive_prompt_defaults_to_default_dir (non-TTY): no flag → no prompt, marker persists the `~/.gan-module-state` default expanded against HOME', async () => {
    const { tmp, pathOverride, cwd } = setup();

    // Non-TTY harness run (stdin is 'ignore') with no flag.
    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    // No interactive module-state prompt emitted in non-TTY mode.
    expect(result.stdout).not.toContain('Module-state root [');

    // Marker persists the default, expanded to the sandbox HOME (no literal `~`).
    const expectedDefault = path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME);
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(expectedDefault);
    expect(resolveModuleStateRoot({ homedir: () => tmp.home, env: {} })).toBe(expectedDefault);
  });

  it('interactive_prompt_defaults_to_default_dir (TTY prompt branch): the prompt names `~/.gan-module-state` as the default and an empty answer (Enter) selects it', async () => {
    // A real PTY is fragile inside the vitest harness. Instead we exercise
    // install.sh's actual prompt branch deterministically: source install.sh
    // with `main "$@"` stripped AND the interactive-branch guard `[ -t 0 ]`
    // inside resolve_module_state_dir forced true, then feed an empty line (the
    // Enter the user would press) on stdin. This runs the SAME prompt/`read`/
    // default-selection code the TTY install runs — mirrors runsDir.test.ts's
    // TTY-prompt test.
    const { tmp } = setup();

    const installRaw = readFileSync(installScriptPath(), 'utf8');
    let trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');
    // Force the prompt branch: replace the `elif [ -t 0 ]; then` guard inside
    // resolve_module_state_dir. That guard token also appears in
    // resolve_runs_dir, so scope the replacement to the function body by
    // splitting on the function header and only rewriting the first guard after
    // it.
    const fnHeader = 'resolve_module_state_dir() {';
    const headerIdx = trimmed.indexOf(fnHeader);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const guard = 'elif [ -t 0 ]; then';
    const guardIdx = trimmed.indexOf(guard, headerIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    trimmed =
      trimmed.slice(0, guardIdx) + 'elif true; then' + trimmed.slice(guardIdx + guard.length);

    const trimmedPath = path.join(tmp.root, 'install-no-main-tty-module.sh');
    writeFileSync(trimmedPath, trimmed);

    const driver = path.join(tmp.root, 'tty-driver-module.sh');
    writeFileSync(
      driver,
      [
        `#!/usr/bin/env bash`,
        `set -uo pipefail`,
        `# shellcheck disable=SC1090`,
        `source ${JSON.stringify(trimmedPath)}`,
        `MODULE_STATE_DIR_FLAG=""`,
        // Empty stdin line = pressing Enter at the prompt.
        `printf '\\n' | { resolve_module_state_dir; printf 'RESOLVED=%s\\n' "$MODULE_STATE_DIR"; }`,
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
    expect(result.stdout).toMatch(/Module-state root \[~\/\.gan-module-state\]:/);

    // The empty answer selected the default, expanded against HOME.
    const expectedDefault = path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME);
    expect(result.stdout).toContain(`RESOLVED=${expectedDefault}`);
  });

  it('bare --module-state-dir with no value dies with framework prose instructing --module-state-dir=<path>', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const result = await runInstall(['--module-state-dir'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('`--module-state-dir` requires a value');
    expect(result.stderr).toContain('--module-state-dir=<path>');
    // No marker written on the death path.
    expect(existsSync(markerPath(tmp.home))).toBe(false);
  });
});

describe('install.sh --module-state-dir — NO settings.json grant (the F8 parity-MINUS)', () => {
  it('install_no_settings_grant: a --module-state-dir install writes the marker but adds no allow rule and no additionalDirectories entry for the module store', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'no-grant-module-store');

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    // Marker persisted.
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(moduleStateDir);

    // No settings.json entry references the module-state root.
    expectNoModuleStateGrant(tmp.home, moduleStateDir);
  });

  it('install_no_settings_grant (pre-seeded settings.json): the module-state install leaves a pre-existing settings.json carrying no module-store entry', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'preseed-no-grant-module-store');

    // Pre-seed settings.json so we can confirm the module-state path adds nothing
    // referencing the module-state root (other framework writes — e.g. the
    // confine-hook registration / minimal permission — may exist, but none names
    // the module store).
    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    writeFileSync(
      settingsPath(tmp.home),
      JSON.stringify(
        {
          permissions: { allow: ['Read(//etc/hosts)'], additionalDirectories: ['/opt/keep'] },
          someUnrelatedKey: 7,
        },
        null,
        2,
      ) + '\n',
    );

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    // Marker persisted.
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(moduleStateDir);

    // No module-store grant; the pre-existing unrelated entries survive.
    expectNoModuleStateGrant(tmp.home, moduleStateDir);
    const settings = readSettings(tmp.home);
    expect((settings.permissions?.allow ?? []).map(String)).toContain('Read(//etc/hosts)');
    expect((settings.permissions?.additionalDirectories ?? []).map(String)).toContain('/opt/keep');
    expect(settings.someUnrelatedKey).toBe(7);
  });
});

describe('install.sh --module-state-dir — STATE_LOG (function-level)', () => {
  it('state_log_entry_recorded: configure_module_state_dir records module-state-dir-configured and NO module-state-dir-permission-granted', async () => {
    // Source install.sh with `main "$@"` stripped, drive resolve + configure
    // directly, and dump STATE_LOG. Mirrors runsDir.test.ts's STATE_LOG test.
    const { tmp } = setup();
    const moduleStateDir = path.join(tmp.root, 'state-log-module-store');

    const installRaw = readFileSync(installScriptPath(), 'utf8');
    const trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');
    const trimmedPath = path.join(tmp.root, 'install-no-main-module.sh');
    writeFileSync(trimmedPath, trimmed);

    const driver = path.join(tmp.root, 'driver-module.sh');
    writeFileSync(
      driver,
      [
        `#!/usr/bin/env bash`,
        `set -uo pipefail`,
        `# shellcheck disable=SC1090`,
        `source ${JSON.stringify(trimmedPath)}`,
        `MODULE_STATE_DIR_FLAG=${JSON.stringify(moduleStateDir)}`,
        `resolve_module_state_dir`,
        `configure_module_state_dir`,
        `printf '%s\\n' "\${STATE_LOG[@]}"`,
        // A settings.json must NOT have been created by configure_module_state_dir.
        `printf 'SETTINGS_EXISTS=%s\\n' "$([ -f "$HOME/.claude/settings.json" ] && echo yes || echo no)"`,
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
    expect(lines).toContain(`module-state-dir-configured:${moduleStateDir}`);
    // The F8 parity-MINUS: NO permission-granted entry exists.
    expect(lines.some((l) => l.startsWith('module-state-dir-permission-granted'))).toBe(false);
    // configure_module_state_dir made no settings.json edit (marker-only).
    expect(result.stdout).toContain('SETTINGS_EXISTS=no');
  });
});

describe('install.sh --uninstall — removes the module-state marker (marker-only)', () => {
  it('uninstall_removes_marker: strips the module-state marker, touches no settings.json, idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'uninstall-module-store');

    // Pre-seed unrelated settings entries we must preserve (proving the
    // module-state uninstall never touches settings.json).
    mkdirSync(path.dirname(settingsPath(tmp.home)), { recursive: true });
    writeFileSync(
      settingsPath(tmp.home),
      JSON.stringify(
        {
          permissions: { allow: ['Read(//etc/hosts)'], additionalDirectories: ['/opt/keep-me'] },
          keepMe: 'survivor',
        },
        null,
        2,
      ) + '\n',
    );

    const installed = await runInstall([`--module-state-dir=${moduleStateDir}`], {
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

    // settings.json never carried (and still does not carry) a module-store entry,
    // and the unrelated entries survive the uninstall untouched.
    expectNoModuleStateGrant(tmp.home, moduleStateDir);
    const after = readSettings(tmp.home);
    expect((after.permissions?.allow ?? []).map(String)).toContain('Read(//etc/hosts)');
    expect((after.permissions?.additionalDirectories ?? []).map(String)).toContain('/opt/keep-me');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

    // Idempotent: a second uninstall against the now-clean HOME exits 0 and
    // removes nothing further.
    const second = await runInstall(['--uninstall'], { home: tmp.home, pathOverride, cwd });
    expect(second.exitCode).toBe(0);
    expect(existsSync(markerPath(tmp.home))).toBe(false);
  });
});

describe('install.sh --module-state-dir — partial-failure rollback', () => {
  it('rollback removes a newly-created marker; no straggler tmp/preedit files', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'rollback-module-store-new');

    const env = makeFailureEnv();
    injectFailureAt(env, 'module-state-dir-config');

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    // Marker removed (the run created it).
    expect(existsSync(markerPath(tmp.home))).toBe(false);

    // No straggler tmp/preedit files for the module-state marker.
    const ganDir = path.join(tmp.home, '.claude', 'gan');
    if (existsSync(ganDir)) {
      expect(
        readdirSync(ganDir).filter(
          (e) => e.startsWith('module-state-dir.tmp.') || e.startsWith('module-state-dir.preedit-'),
        ),
      ).toEqual([]);
    }
  });

  it('rollback byte-restores a pre-existing marker; no straggler tmp/preedit files', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'rollback-module-store-existing');

    // Pre-seed a marker so rollback must byte-restore (not remove) it.
    const mp = markerPath(tmp.home);
    mkdirSync(path.dirname(mp), { recursive: true });
    const preExistingMarker = '/some/prior/module-state-root\n';
    writeFileSync(mp, preExistingMarker);

    const env = makeFailureEnv();
    injectFailureAt(env, 'module-state-dir-config');

    const result = await runInstall([`--module-state-dir=${moduleStateDir}`], {
      home: tmp.home,
      pathOverride,
      cwd,
      extraEnv: env.env,
    });
    expect(result.exitCode).not.toBe(0);

    // Marker byte-restored from the preedit snapshot.
    expect(readFileSync(mp, 'utf8')).toBe(preExistingMarker);

    // No straggler tmp/preedit files.
    const ganDir = path.join(tmp.home, '.claude', 'gan');
    expect(
      readdirSync(ganDir).filter(
        (e) => e.startsWith('module-state-dir.tmp.') || e.startsWith('module-state-dir.preedit-'),
      ),
    ).toEqual([]);
  });
});

describe('install.sh --module-state-dir — shell/subprocess safety (no injection)', () => {
  it('module_state_dir_value_quoted_no_injection: a hostile path with shell metacharacters installs cleanly, persists literally, and creates no injected side-effect', async () => {
    const { tmp, pathOverride, cwd } = setup();
    // A store-root path carrying `$(...)`, `;`, backticks and a space. If the
    // value were interpolated into a shell/eval string or the node program text,
    // the `touch PWNED` fragment would run; quoting treats it as a literal path.
    const hostile = path.join(tmp.root, 'evil $(touch PWNED);` ` module store');

    const result = await runInstall([`--module-state-dir=${hostile}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    // No injected side-effect file anywhere observable.
    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(cwd, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.home, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(repoRootDir(), 'PWNED'))).toBe(false);

    // The marker contains the literal path byte-for-byte (single trimmed line).
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(hostile);

    // No settings.json grant references the hostile module-state root either.
    expectNoModuleStateGrant(tmp.home, hostile);

    // The resolver reads back exactly the literal path.
    expect(resolveModuleStateRoot({ homedir: () => tmp.home, env: {} })).toBe(
      path.normalize(hostile),
    );
  });

  it('no `eval` command and every module-state-root value expansion in install.sh is double-quoted', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');
    // Code lines only: drop the comment portion of each line so prose like
    // "no `eval`" / variable names mentioned in comments is ignored.
    const codeLines = installRaw.split('\n').map((l) => l.replace(/#.*$/, ''));

    // Static: no actual `eval` COMMAND is invoked.
    for (const code of codeLines) {
      expect(code).not.toMatch(/(^|[;&|]\s*)\beval\b/);
    }

    // The untrusted module-state value flows through two shell variables:
    // $MODULE_STATE_DIR and $MODULE_STATE_DIR_FLAG. Every EXPANSION of each must
    // occur inside a double-quoted span. We track double-quote state per
    // character — honouring single-quoted spans — and, for each
    // `$<value-var>` expansion, assert the cursor is inside a double quote.
    // The `(?![A-Za-z0-9_])` boundary prevents matching the constant-name
    // prefixes (`MODULE_STATE_DIR_MARKER_PATH`, `MODULE_STATE_DIR_DEFAULT`,
    // `MODULE_STATE_DIR_MARKER_PREEDIT`, etc.) — those are framework-owned
    // constants, not the untrusted value.
    const valueVarRe = /^(MODULE_STATE_DIR|MODULE_STATE_DIR_FLAG)(?![A-Za-z0-9_])/;
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

describe('install.sh --module-state-dir — no committed secret/home literal (static)', () => {
  it('no_secret_or_home_literal_committed: the new install.sh/test code carries no absolute home/store literal — only the `~/.gan-module-state` tilde default and runtime-derived values', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');
    const thisTestRaw = readFileSync(
      path.join(repoRootDir(), 'tests', 'installer', 'moduleStateDir.test.ts'),
      'utf8',
    );
    for (const src of [installRaw, thisTestRaw]) {
      // No developer-home absolute path literals baked in.
      expect(src).not.toMatch(/\/Users\/[a-z]/i);
      expect(src).not.toMatch(/\/home\/[a-z]/i);
    }
    // The only module-state-path default literal in install.sh is the tilde form.
    expect(installRaw).toContain('~/.gan-module-state');
    expect(installRaw).toContain('$HOME/.gan-module-state');
  });
});

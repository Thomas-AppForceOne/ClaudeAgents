
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

function expectNoModuleStateGrant(home: string, moduleStateRoot: string): void {
  if (!existsSync(settingsPath(home))) {

    return;
  }
  const settings = readSettings(home);
  const allow = (settings.permissions?.allow ?? []).map(String);
  const addl = (settings.permissions?.additionalDirectories ?? []).map(String);

  expect(allow).not.toContain(`Read(${moduleStateRoot}/**)`);
  expect(allow).not.toContain(`Write(${moduleStateRoot}/**)`);
  expect(allow).not.toContain(`Edit(${moduleStateRoot}/**)`);

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

    expect(resolveModuleStateRoot({ homedir, env: {} })).toBe(path.normalize(moduleStateDir));

    const other = path.join(tmp.root, 'env-override-module');
    expect(resolveModuleStateRoot({ homedir, env: { GAN_MODULE_STATE: other } })).toBe(
      path.normalize(other),
    );

    const { rmSync } = await import('node:fs');
    rmSync(markerPath(tmp.home));
    expect(resolveModuleStateRoot({ homedir, env: {} })).toBe(
      path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME),
    );
  });

  it('interactive_prompt_defaults_to_default_dir (non-TTY): no flag → no prompt, marker persists the `~/.gan-module-state` default expanded against HOME', async () => {
    const { tmp, pathOverride, cwd } = setup();

    const result = await runInstall([], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).toBe(0);

    expect(result.stdout).not.toContain('Module-state root [');

    const expectedDefault = path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME);
    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(expectedDefault);
    expect(resolveModuleStateRoot({ homedir: () => tmp.home, env: {} })).toBe(expectedDefault);
  });

  it('interactive_prompt_defaults_to_default_dir (TTY prompt branch): the prompt names `~/.gan-module-state` as the default and an empty answer (Enter) selects it', async () => {

    const { tmp } = setup();

    const installRaw = readFileSync(installScriptPath(), 'utf8');
    let trimmed = installRaw.replace(/\nmain "\$@"\s*$/, '\n');

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

    expect(result.stdout).toMatch(/Module-state root \[~\/\.gan-module-state\]:/);

    const expectedDefault = path.join(tmp.home, DEFAULT_MODULE_STATE_DIRNAME);
    expect(result.stdout).toContain(`RESOLVED=${expectedDefault}`);
  });

  it('bare --module-state-dir with no value dies with framework prose instructing --module-state-dir=<path>', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const result = await runInstall(['--module-state-dir'], { home: tmp.home, pathOverride, cwd });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('`--module-state-dir` requires a value');
    expect(result.stderr).toContain('--module-state-dir=<path>');

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

    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(moduleStateDir);

    expectNoModuleStateGrant(tmp.home, moduleStateDir);
  });

  it('install_no_settings_grant (pre-seeded settings.json): the module-state install leaves a pre-existing settings.json carrying no module-store entry', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'preseed-no-grant-module-store');

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

    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(moduleStateDir);

    expectNoModuleStateGrant(tmp.home, moduleStateDir);
    const settings = readSettings(tmp.home);
    expect((settings.permissions?.allow ?? []).map(String)).toContain('Read(//etc/hosts)');
    expect((settings.permissions?.additionalDirectories ?? []).map(String)).toContain('/opt/keep');
    expect(settings.someUnrelatedKey).toBe(7);
  });
});

describe('install.sh --module-state-dir — STATE_LOG (function-level)', () => {
  it('state_log_entry_recorded: configure_module_state_dir records module-state-dir-configured and NO module-state-dir-permission-granted', async () => {

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

    expect(lines.some((l) => l.startsWith('module-state-dir-permission-granted'))).toBe(false);

    expect(result.stdout).toContain('SETTINGS_EXISTS=no');
  });
});

describe('install.sh --uninstall — removes the module-state marker (marker-only)', () => {
  it('uninstall_removes_marker: strips the module-state marker, touches no settings.json, idempotent', async () => {
    const { tmp, pathOverride, cwd } = setup();
    const moduleStateDir = path.join(tmp.root, 'uninstall-module-store');

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

    expect(existsSync(markerPath(tmp.home))).toBe(false);

    expectNoModuleStateGrant(tmp.home, moduleStateDir);
    const after = readSettings(tmp.home);
    expect((after.permissions?.allow ?? []).map(String)).toContain('Read(//etc/hosts)');
    expect((after.permissions?.additionalDirectories ?? []).map(String)).toContain('/opt/keep-me');
    expect((after as Record<string, unknown>).keepMe).toBe('survivor');

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

    expect(existsSync(markerPath(tmp.home))).toBe(false);

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

    expect(readFileSync(mp, 'utf8')).toBe(preExistingMarker);

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

    const hostile = path.join(tmp.root, 'evil $(touch PWNED);` ` module store');

    const result = await runInstall([`--module-state-dir=${hostile}`], {
      home: tmp.home,
      pathOverride,
      cwd,
    });
    expect(result.exitCode).toBe(0);

    expect(existsSync(path.join(tmp.root, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(cwd, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(tmp.home, 'PWNED'))).toBe(false);
    expect(existsSync(path.join(repoRootDir(), 'PWNED'))).toBe(false);

    expect(readFileSync(markerPath(tmp.home), 'utf8').trim()).toBe(hostile);

    expectNoModuleStateGrant(tmp.home, hostile);

    expect(resolveModuleStateRoot({ homedir: () => tmp.home, env: {} })).toBe(
      path.normalize(hostile),
    );
  });

  it('no `eval` command and every module-state-root value expansion in install.sh is double-quoted', () => {
    const installRaw = readFileSync(installScriptPath(), 'utf8');

    const codeLines = installRaw.split('\n').map((l) => l.replace(/#.*$/, ''));

    for (const code of codeLines) {
      expect(code).not.toMatch(/(^|[;&|]\s*)\beval\b/);
    }

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

      expect(src).not.toMatch(/\/Users\/[a-z]/i);
      expect(src).not.toMatch(/\/home\/[a-z]/i);
    }

    expect(installRaw).toContain('~/.gan-module-state');
    expect(installRaw).toContain('$HOME/.gan-module-state');
  });
});

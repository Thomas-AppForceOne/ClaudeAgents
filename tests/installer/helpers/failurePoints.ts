/**
 * R2 sprint 3 — failure-injection helper for installer rollback tests.
 *
 * `injectFailureAt()` mutates an environment-variable map that gets
 * threaded into `runInstall({ extraEnv })`, and (where needed) writes
 * extra stub binaries into the supplied stub-bin directory. Each
 * named point causes `install.sh` to fail at the corresponding step:
 *
 *   - 'npm-install' — fake `npm` exits 1 on an `install`-flavoured
 *     invocation when `CAS_FAIL_NPM_INSTALL=1` is in the environment.
 *     (The version-probe path is unaffected; this only triggers when
 *     `install_mcp_server` actually runs.)
 *
 *   - 'json-edit'   — a stub `node` wrapper exits 1 for `node -e ...`
 *     invocations when `CAS_FAIL_JSON_EDIT=1` is in the environment.
 *     `node --version` and `node -p ...` (used by `read_mcp_server_version`)
 *     still delegate to the real host node so prereq checks pass.
 *
 *   - 'zone-prep'   — a stub `mkdir` wrapper exits 1 when invoked with a
 *     path ending in `.gan-state` or `.gan-cache` and `CAS_FAIL_ZONE_PREP=1`
 *     is in the environment. Other `mkdir` invocations delegate to
 *     `/bin/mkdir`, so the installer's earlier `mkdir -p ~/.claude/agents`
 *     calls still succeed.
 *
 *   - 'confine-hook-write' — sets `CAS_FAIL_CONFINE_HOOK_WRITE=1`,
 *     which `write_confine_hook` reads at the END of its body, AFTER it has
 *     rendered the hook to `~/.claude/hooks/gan-confine.sh` and merged the
 *     `hooks.PreToolUse[]` registration into `~/.claude/settings.json`. The
 *     installer then returns non-zero, routing through its real ERR trap and
 *     `rollback()` so a test can assert the partial hook file is removed and
 *     the settings.json registration is gone (restored from the preedit copy).
 *     No stub binary is required — the failure is an env-flagged branch in
 *     install.sh's own real code path, leaving every other side effect real.
 *
 *   - 'runs-dir-config' — (F7 slice 5) sets `CAS_FAIL_RUNS_DIR_CONFIG=1`,
 *     which `configure_runs_dir` reads at the END of its body, AFTER it has
 *     written the central-store marker (`~/.claude/gan/runs-data-dir`) and
 *     merged the store-root read/write grant into `~/.claude/settings.json`.
 *     The installer then returns non-zero, routing through the real ERR trap
 *     and `rollback()` so a test can assert BOTH writes are undone (marker
 *     removed/restored, settings grant gone). Same env-flagged-branch shape as
 *     'confine-hook-write' — no stub binary required.
 *
 *   - 'module-state-dir-config' — (F8) sets `CAS_FAIL_MODULE_STATE_DIR_CONFIG=1`,
 *     which `configure_module_state_dir` reads at the END of its body, AFTER it
 *     has written the module-state marker (`~/.claude/gan/module-state-dir`).
 *     The installer then returns non-zero, routing through the real ERR trap and
 *     `rollback()` so a test can assert the marker write is undone (marker
 *     removed when newly created, byte-restored when pre-existing). PARITY-MINUS
 *     vs 'runs-dir-config': F8 writes NO settings.json grant, so there is no
 *     second write to undo — the rollback is marker-only. Same
 *     env-flagged-branch shape as 'runs-dir-config' — no stub binary required.
 *
 * The helper deliberately works via env-flagged stubs (rather than
 * patching `install.sh`) so the script under test sees its real code
 * paths — only the side-effect surface is faked.
 */
import { writeStubBin } from './tmpenv.js';

export type FailurePoint =
  | 'npm-install'
  | 'json-edit'
  | 'zone-prep'
  | 'confine-hook-write'
  | 'runs-dir-config'
  | 'module-state-dir-config';

export interface FailurePointEnv {
  /** Env vars the stubs read to know whether to fail. */
  env: Record<string, string>;
}

export function makeFailureEnv(): FailurePointEnv {
  return { env: {} };
}

/**
 * Mutates `target.env` to flip the named failure point on. For points
 * that need an extra stub binary (`json-edit`, `zone-prep`), writes the
 * stub into `bin` — the caller is responsible for supplying the same
 * stub-bin dir its `runInstall()` call uses.
 *
 * `hostNode` is the absolute path to a real Node interpreter the
 * `json-edit` stub falls back to for non-`-e` invocations; defaults to
 * `process.execPath`.
 *
 * Returns `target` for chaining.
 */
export function injectFailureAt(
  target: FailurePointEnv,
  point: FailurePoint,
  bin?: string,
  hostNode?: string,
): FailurePointEnv {
  switch (point) {
    case 'npm-install':
      target.env.CAS_FAIL_NPM_INSTALL = '1';
      break;
    case 'json-edit': {
      target.env.CAS_FAIL_JSON_EDIT = '1';
      if (bin === undefined) {
        throw new Error("injectFailureAt('json-edit'): bin path is required");
      }
      const node = hostNode ?? process.execPath;
      // Re-write the `node` stub so `node -e ...` fails when the env
      // var is set, while `node --version` and `node -p ...` still
      // shell through to the real interpreter. The default version
      // emitted is `v20.10.0` to satisfy the prereq range; tests that
      // care about a specific version can re-stub afterwards.
      writeStubBin(
        bin,
        'node',
        [
          `if [ "$1" = "--version" ]; then`,
          `  printf '%s\\n' "v20.10.0"`,
          `  exit 0`,
          `fi`,
          `if [ "$1" = "-e" ] && [ "\${CAS_FAIL_JSON_EDIT:-0}" = "1" ]; then`,
          `  printf '%s\\n' "install.sh: injected JSON-edit failure" >&2`,
          `  exit 1`,
          `fi`,
          `exec ${JSON.stringify(node)} "$@"`,
        ].join('\n'),
      );
      break;
    }
    case 'zone-prep': {
      target.env.CAS_FAIL_ZONE_PREP = '1';
      if (bin === undefined) {
        throw new Error("injectFailureAt('zone-prep'): bin path is required");
      }
      // Stub `mkdir` that fails when one of the args ends in
      // `.gan-state` or `.gan-cache` (the zone names). All other
      // invocations forward to `/bin/mkdir`. By placing this stub in
      // the override bin, the installer's earlier `mkdir` calls still
      // succeed (they target `~/.claude/agents` etc., not zone paths).
      writeStubBin(
        bin,
        'mkdir',
        [
          `if [ "\${CAS_FAIL_ZONE_PREP:-0}" = "1" ]; then`,
          `  for a in "$@"; do`,
          `    case "$a" in`,
          `      *.gan-state|*.gan-cache)`,
          `        printf '%s\\n' "mkdir: injected zone-prep failure for $a" >&2`,
          `        exit 1`,
          `        ;;`,
          `    esac`,
          `  done`,
          `fi`,
          `exec /bin/mkdir "$@"`,
        ].join('\n'),
      );
      break;
    }
    case 'confine-hook-write':
      // Pure env-flagged branch in install.sh's own `write_confine_hook`
      // — no stub binary needed. The flag is read after the hook + settings
      // registration have been written, so rollback exercises the real
      // partial-state cleanup.
      target.env.CAS_FAIL_CONFINE_HOOK_WRITE = '1';
      break;
    case 'runs-dir-config':
      // (F7 slice 5) Pure env-flagged branch in install.sh's own
      // `configure_runs_dir` — no stub binary needed. The flag is read after
      // BOTH the marker and the settings grant have been written, so rollback
      // exercises the real partial-state cleanup of both.
      target.env.CAS_FAIL_RUNS_DIR_CONFIG = '1';
      break;
    case 'module-state-dir-config':
      // (F8) Pure env-flagged branch in install.sh's own
      // `configure_module_state_dir` — no stub binary needed. The flag is read
      // after the marker has been written, so rollback exercises the real
      // partial-state cleanup of the marker. No settings grant exists to undo
      // (F8 parity-MINUS).
      target.env.CAS_FAIL_MODULE_STATE_DIR_CONFIG = '1';
      break;
    default: {
      // exhaustiveness check
      const _never: never = point;
      void _never;
      throw new Error(`unknown failure point: ${String(point)}`);
    }
  }
  return target;
}

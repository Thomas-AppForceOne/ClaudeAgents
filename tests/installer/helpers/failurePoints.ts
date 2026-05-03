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
 * The helper deliberately works via env-flagged stubs (rather than
 * patching `install.sh`) so the script under test sees its real code
 * paths — only the side-effect surface is faked.
 */
import { writeStubBin } from './tmpenv.js';

export type FailurePoint = 'npm-install' | 'json-edit' | 'zone-prep';

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
    default: {
      // exhaustiveness check
      const _never: never = point;
      void _never;
      throw new Error(`unknown failure point: ${String(point)}`);
    }
  }
  return target;
}


import { writeStubBin } from './tmpenv.js';

export type FailurePoint =
  | 'npm-install'
  | 'json-edit'
  | 'zone-prep'
  | 'confine-hook-write'
  | 'runs-dir-config'
  | 'module-state-dir-config';

export interface FailurePointEnv {

  env: Record<string, string>;
}

export function makeFailureEnv(): FailurePointEnv {
  return { env: {} };
}

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

      target.env.CAS_FAIL_CONFINE_HOOK_WRITE = '1';
      break;
    case 'runs-dir-config':

      target.env.CAS_FAIL_RUNS_DIR_CONFIG = '1';
      break;
    case 'module-state-dir-config':

      target.env.CAS_FAIL_MODULE_STATE_DIR_CONFIG = '1';
      break;
    default: {

      const _never: never = point;
      void _never;
      throw new Error(`unknown failure point: ${String(point)}`);
    }
  }
  return target;
}

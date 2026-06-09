/**
 * Fault-injection seams for the install/rollback suites.
 *
 * The installer is built to roll back cleanly when any step fails partway
 * through. To exercise that without relying on real, flaky failures, the
 * installer honours a set of `CAS_FAIL_*` environment variables that force a
 * specific step to fail deterministically; some steps additionally need a
 * stubbed binary on `PATH` that fails only when its trigger var is set. This
 * module names those failure points and wires up both halves (env var, and the
 * stub binary where required) so a test can say "fail at step X, then assert
 * everything earlier was undone".
 *
 * The two binary-backed points (`json-edit`, `zone-prep`) install a fake
 * `node` / `mkdir` whose embedded shell DATA reproduces the real tool's
 * behaviour except when the injected `CAS_FAIL_*` var is `1`, at which point it
 * prints an error and exits non-zero. The remaining points are pure env flags
 * the installer itself checks.
 */

import { writeStubBin } from './tmpenv.js';

/**
 * The set of installer steps that can be made to fail on demand. Each value
 * maps to a `CAS_FAIL_*` env var (and, for `json-edit`/`zone-prep`, a stubbed
 * binary):
 * - `npm-install` — the dependency-install steps: the global package install
 *   (`npm install -g .`) and the cold-path bootstrap dependency install
 *   (`npm ci --ignore-scripts`). One flag (`CAS_FAIL_NPM_INSTALL`) trips
 *   whichever of the two the installer reaches first.
 * - `json-edit` — the node-driven edit of `~/.claude.json`.
 * - `zone-prep` — creation of the `.gan-state` / `.gan-cache` zone dirs.
 * - `confine-hook-write` — writing/registering the confinement hook.
 * - `runs-dir-config` — persisting the runs-dir marker + settings grant.
 * - `module-state-dir-config` — persisting the module-state-dir marker.
 */
export type FailurePoint =
  | 'npm-install'
  | 'json-edit'
  | 'zone-prep'
  | 'confine-hook-write'
  | 'runs-dir-config'
  | 'module-state-dir-config';

/**
 * Accumulator for injected failures: the env-var bag to splice into a
 * `runInstall` call. Built empty by {@link makeFailureEnv} and mutated in place
 * by {@link injectFailureAt}.
 *
 * @property env the `CAS_FAIL_*` (and any companion) variables to pass through
 *   to the installer process.
 */
export interface FailurePointEnv {

  env: Record<string, string>;
}

/**
 * Create an empty {@link FailurePointEnv} to be populated by
 * {@link injectFailureAt}.
 */
export function makeFailureEnv(): FailurePointEnv {
  return { env: {} };
}

/**
 * Arm a failure at `point` on `target`, returning the same (mutated) object for
 * chaining.
 *
 * For env-only points this just sets the matching `CAS_FAIL_*` flag. For the
 * two binary-backed points it also writes a stub onto `PATH`:
 * - `json-edit` requires `bin` (the stub directory). The stub answers
 *   `node --version` truthfully (so the prerequisite check still passes) but
 *   fails any `node -e ...` invocation while `CAS_FAIL_JSON_EDIT=1`, simulating
 *   a failed JSON edit *after* npm install has already run. `hostNode` is the
 *   real node to delegate non-failing calls to (defaults to the test runner's
 *   own `process.execPath`).
 * - `zone-prep` requires `bin`. The stub fails `mkdir` only for paths ending in
 *   `.gan-state` / `.gan-cache` (so unrelated directory creation still works),
 *   isolating the failure to the zone-prep step.
 *
 * @param target the env accumulator to mutate.
 * @param point which step to make fail.
 * @param bin path to the stub-binary directory; required for `json-edit` and
 *   `zone-prep`, ignored otherwise.
 * @param hostNode override for the real node binary the `json-edit` stub
 *   delegates to; defaults to `process.execPath`.
 * @returns `target`, for fluent chaining.
 * @throws Error when `bin` is omitted for a point that needs it, or when
 *   `point` is not a known {@link FailurePoint} (the exhaustiveness guard).
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

      // Stub `node`: report a passing version for the prerequisite probe, fail
      // the `-e` JSON-edit invocation while the flag is set, and exec the real
      // node for every other call so the rest of the install behaves normally.
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

      // Stub `mkdir`: fail only when asked to create a zone dir (a path ending
      // in `.gan-state` / `.gan-cache`) so the failure is scoped to zone prep;
      // any other mkdir delegates to the real binary.
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

      // Exhaustiveness guard: assigning `point` to `never` makes the compiler
      // flag any FailurePoint added to the union but not handled above.
      const _never: never = point;
      void _never;
      throw new Error(`unknown failure point: ${String(point)}`);
    }
  }
  return target;
}

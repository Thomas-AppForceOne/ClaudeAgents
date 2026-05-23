/**
 * `gan modules list` — print the modules registered for a project.
 *
 * A read-only command: it never writes and delegates project-root resolution,
 * `--json` handling, and error mapping to {@link runRead}.
 */

import { listModules } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Shape returned by `listModules` and consumed by {@link renderHuman}.
 *
 * @property modules the registered module names; empty when none are
 *   registered (a valid state, not an error).
 */
interface ListModulesResponse {
  modules: string[];
}

/**
 * Render the module list for human (non-JSON) output.
 *
 * @param resp the registered-modules response.
 * @returns one module name per line (trailing newline); when the list is
 *   empty, a fixed notice that no modules are registered (module registration
 *   is the not-yet-shipped M1 milestone).
 */
function renderHuman(resp: ListModulesResponse): string {
  if (resp.modules.length === 0) {
    return 'No modules registered (M1 not yet implemented).\n';
  }
  return resp.modules.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan modules list`.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root` via
 *   {@link runRead}.
 * @returns a {@link CommandResult}; exit code is OK on success or an
 *   error-mapped code if project-root resolution / the lookup throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(
    parsed,
    (projectRoot) => Promise.resolve(listModules({ projectRoot })),
    renderHuman,
  );
}

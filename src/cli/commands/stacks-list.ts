/**
 * `gan stacks list` — print the stacks currently *active* in the resolved
 * config for a project (the ordered `stacks.active` list), as opposed to
 * `gan stacks available` which lists every built-in stack on disk.
 *
 * A read-only command: it never writes and delegates project-root resolution,
 * `--json` handling, and error mapping to {@link runRead}.
 */

import { getActiveStacks } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Shape returned by `getActiveStacks` and consumed by {@link renderHuman}.
 *
 * @property active the active stack names in resolution order; an empty array
 *   means no stack is active (a valid state, not an error).
 */
interface ActiveStacksResponse {
  active: string[];
}

/**
 * Render the active-stacks response for human (non-JSON) output.
 *
 * @param resp the resolved active-stacks list.
 * @returns one stack name per line (trailing newline), or the literal
 *   `(none)\n` when no stack is active.
 */
function renderHuman(resp: ActiveStacksResponse): string {
  if (resp.active.length === 0) return '(none)\n';
  return resp.active.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan stacks list`.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root` via the
 *   shared {@link runRead} wrapper.
 * @returns a {@link CommandResult}; exit code is OK on success or an
 *   error-mapped code if project-root resolution / config load throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(
    parsed,
    (projectRoot) => Promise.resolve(getActiveStacks({ projectRoot })),
    renderHuman,
  );
}

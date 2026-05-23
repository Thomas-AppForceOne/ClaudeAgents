/**
 * Placeholder command handlers for subcommands that are routed but not yet
 * implemented in the current sprint.
 *
 * Each stub honours the standard command contract — it returns a
 * {@link CommandResult} rather than throwing — so the router can wire it in
 * exactly like a real handler. Every stub writes its notice to `stderr` (never
 * `stdout`) and exits non-zero, so a stub is never mistaken for a successful
 * no-op by a script consuming `stdout`.
 */

import { EXIT_GENERIC } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Result contract shared by every CLI command handler.
 *
 * @property stdout text for standard output (the command's real result).
 * @property stderr text for standard error (diagnostics / notices).
 * @property code the process exit code.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Build a "not yet implemented" handler for a specific command.
 *
 * @param fullCommand the user-facing command name to name in the notice (e.g.
 *   `gan foo bar`), so the message points at the exact command invoked.
 * @returns an async handler that ignores its parsed args and resolves to a
 *   {@link CommandResult} whose `stderr` carries the not-implemented notice
 *   and whose exit code is {@link EXIT_GENERIC}. Never throws; never writes
 *   `stdout`.
 */
export function makeNotYetStub(
  fullCommand: string,
): (parsed: ParsedArgs) => Promise<CommandResult> {
  return async (_parsed: ParsedArgs) => {
    return {
      stdout: '',
      stderr: `${fullCommand}: not yet implemented in this sprint\n`,
      code: EXIT_GENERIC,
    };
  };
}

/**
 * Stub handler for the `gan trust` command family, which is scheduled to ship
 * with the R5 milestone.
 *
 * @param _parsed parsed argv (ignored).
 * @returns a {@link CommandResult} announcing the R5 ship target on `stderr`
 *   with exit code {@link EXIT_GENERIC}. Never throws.
 */
export async function trustStub(_parsed: ParsedArgs): Promise<CommandResult> {
  return {
    stdout: '',
    stderr: 'gan trust ships with R5.\n',
    code: EXIT_GENERIC,
  };
}

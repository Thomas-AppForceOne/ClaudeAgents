/**
 * `gan help [subcommand]` — render usage text.
 *
 * With no argument it prints the top-level overview; with a subcommand name it
 * prints that subcommand's help. Always succeeds (exit OK) and writes to
 * `stdout`: requesting help is never an error, even for an unknown name (the
 * help renderer decides how to present that).
 */

import { renderSubcommandHelp, renderTopLevelHelp } from '../lib/help.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Result contract shared by every CLI command handler.
 *
 * @property stdout text for standard output.
 * @property stderr text for standard error.
 * @property code the process exit code.
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * CLI entrypoint for `gan help`.
 *
 * @param parsed parsed argv; the first positional (`parsed._[0]`) is the
 *   optional subcommand to describe.
 * @returns a {@link CommandResult} carrying the help text on `stdout` with
 *   exit {@link EXIT_OK}. Never throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  // No subcommand → top-level overview; otherwise help for that subcommand.
  const sub = parsed._[0];
  const stdout = sub ? renderSubcommandHelp(sub) : renderTopLevelHelp();
  return { stdout, stderr: '', code: EXIT_OK };
}

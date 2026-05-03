/**
 * R3 sprint 1 — `gan help [<subcommand>]`.
 *
 * Delegates to `lib/help.ts`. Exits 0; never errors. Per the R3 help-output
 * rule, help always goes to stdout.
 */

import { renderSubcommandHelp, renderTopLevelHelp } from '../lib/help.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  // `gan help` -> top-level. `gan help <name>` -> per-subcommand.
  const sub = parsed._[0];
  const stdout = sub ? renderSubcommandHelp(sub) : renderTopLevelHelp();
  return { stdout, stderr: '', code: EXIT_OK };
}

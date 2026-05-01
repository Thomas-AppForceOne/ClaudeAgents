/**
 * R3 sprint 1 — placeholder dispatcher arms for subcommands that ship in
 * a later sprint (and the trust subcommand surface that ships with R5).
 *
 * S2 (read subcommands) and S3 (write subcommands) replaced their stub
 * arms with real handlers:
 *   - `gan config print`, `gan config get`, `gan config set`
 *   - `gan stacks list`
 *   - `gan stack show`, `gan stack update`
 *   - `gan modules list`
 *
 * The remaining stubs surface the not-yet-implemented `stacks new` (S4)
 * and `validate` (S4) arms — plus R5's `trust` surface. Each stub prints
 * a short stderr message and exits 1. The trust stub names R5 explicitly;
 * the S4 stubs use the canonical "not yet implemented in this sprint"
 * wording.
 */

import { EXIT_GENERIC } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Build a "not yet implemented in this sprint" stub for an S2-S4 command.
 * Includes the *full* user-typed command string so the message is
 * unambiguous when `gan stack update <field> <value>` lands in S3 etc.
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
 * Stub for `gan trust *`. Trust subcommands are R5's territory (per the
 * R3 spec and PROJECT_CONTEXT.md). The stub prints the R5 pointer and
 * exits 1.
 */
export async function trustStub(_parsed: ParsedArgs): Promise<CommandResult> {
  return {
    stdout: '',
    stderr: 'gan trust ships with R5.\n',
    code: EXIT_GENERIC,
  };
}

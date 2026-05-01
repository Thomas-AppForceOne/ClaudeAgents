/**
 * R3 sprint 1 — placeholder dispatcher arms for subcommands that ship in
 * S2-S4 (and the trust subcommand surface that ships with R5).
 *
 * Each stub prints a short stderr message and exits 1. The trust stub
 * names R5 explicitly; the S2-S4 stubs use the canonical "not yet
 * implemented in this sprint" wording per the contract.
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

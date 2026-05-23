

import { EXIT_GENERIC } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

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

export async function trustStub(_parsed: ParsedArgs): Promise<CommandResult> {
  return {
    stdout: '',
    stderr: 'gan trust ships with R5.\n',
    code: EXIT_GENERIC,
  };
}

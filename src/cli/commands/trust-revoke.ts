

import os from 'node:os';

import { trustRevoke } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_BAD_ARGS, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface RevokeResultLike {
  mutated: boolean;
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  if (rootFlag === undefined || rootFlag.length === 0) {
    const err = createError('MalformedInput', {
      field: '--project-root',
      message:
        'gan trust revoke requires --project-root to be set explicitly. ' +
        'Trust-mutating subcommands never default to the current working directory.',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const homeDir = process.env.HOME ?? os.homedir();

  let result: RevokeResultLike;
  try {
    result = trustRevoke({ projectRoot }, { homeDir });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  if (wantJson) {
    return { stdout: stableStringify(result), stderr: '', code: EXIT_OK };
  }

  const human = result.mutated
    ? `Revoked all approvals for ${projectRoot}\n`
    : `No approvals to revoke for ${projectRoot}\n`;
  return { stdout: human, stderr: '', code: EXIT_OK };
}

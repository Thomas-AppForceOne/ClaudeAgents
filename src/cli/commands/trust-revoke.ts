/**
 * `gan trust revoke` — remove all trust approvals for a project.
 *
 * Trust-mutating: like `trust approve`, it *requires* an explicit
 * `--project-root` and never defaults to the working directory. Revoking a
 * project that has no approval is a successful no-op (exit OK), distinguished
 * from a real removal only by the wording / the `mutated` flag.
 */

import os from 'node:os';

import { trustRevoke } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_BAD_ARGS, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Local structural view of the {@link trustRevoke} result.
 *
 * @property mutated `true` when an approval was actually removed; `false` when
 *   the project had none (a no-op, not an error).
 */
interface RevokeResultLike {
  mutated: boolean;
}

/**
 * CLI entrypoint for `gan trust revoke`.
 *
 * @param parsed parsed argv; honours `--json` and requires `--project-root`.
 * @returns a {@link CommandResult}. A missing/empty `--project-root` is
 *   `MalformedInput` with exit {@link EXIT_BAD_ARGS}; project-root resolution
 *   or a thrown revoke error (e.g. a corrupt trust cache) maps via
 *   {@link errorResult}. Otherwise exit {@link EXIT_OK} with a confirmation —
 *   the human wording reflects whether anything was actually revoked.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  // Same deliberate guard as approve: revocation must name its project root.
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

  // HOME wins over os.homedir() so the trust-cache location is overridable.
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

  // No-op revoke is still a success; only the wording differs.
  const human = result.mutated
    ? `Revoked all approvals for ${projectRoot}\n`
    : `No approvals to revoke for ${projectRoot}\n`;
  return { stdout: human, stderr: '', code: EXIT_OK };
}

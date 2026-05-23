/**
 * `gan trust approve` — record the user's trust approval for a project,
 * pinning its current aggregate config hash.
 *
 * Trust-mutating: this command *requires* an explicit `--project-root` and
 * deliberately refuses to default to the current working directory, so a user
 * can never approve "wherever they happen to be standing" by accident.
 */

import os from 'node:os';

import { trustApprove } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_BAD_ARGS, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Local structural view of the {@link trustApprove} result this command
 * renders.
 *
 * @property mutated always `true` — approving always writes a record (there is
 *   no soft-failure arm).
 * @property record the approval that was persisted: the canonical
 *   `projectRoot`, the pinned `aggregateHash`, the ISO-8601 `approvedAt`, and
 *   the optional `approvedCommit` / `note`.
 */
interface ApproveResultLike {
  mutated: true;
  record: {
    projectRoot: string;
    aggregateHash: string;
    approvedAt: string;
    approvedCommit?: string;
    note?: string;
  };
}

/**
 * Render the approval result for human (non-JSON) output.
 *
 * @param r the approval result.
 * @returns a one-line confirmation naming the project root and pinned hash
 *   (trailing newline).
 */
function renderHuman(r: ApproveResultLike): string {
  return `Approved ${r.record.projectRoot} with hash ${r.record.aggregateHash}\n`;
}

/**
 * CLI entrypoint for `gan trust approve`.
 *
 * @param parsed parsed argv; honours `--json`, requires `--project-root`, and
 *   accepts an optional `--note` (an empty value is treated as absent).
 * @returns a {@link CommandResult}. Failure modes are returned as data:
 *   a missing/empty `--project-root` is `MalformedInput` with exit
 *   {@link EXIT_BAD_ARGS}; project-root resolution or a thrown approval error
 *   (e.g. a corrupt trust cache) maps via {@link errorResult}. On success the
 *   record is on `stdout` (deterministically serialised for `--json`) with
 *   exit {@link EXIT_OK}.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  // Refuse to default to cwd: an explicit root is mandatory for any
  // trust-mutating command, so approval is always a deliberate act.
  if (rootFlag === undefined || rootFlag.length === 0) {
    const err = createError('MalformedInput', {
      field: '--project-root',
      message:
        'gan trust approve requires --project-root to be set explicitly. ' +
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
  const noteFlag = parsed.flags['note'];
  const note = typeof noteFlag === 'string' && noteFlag.length > 0 ? noteFlag : undefined;

  let result: ApproveResultLike;
  try {
    // Omit `note` entirely when absent (spread-only-if-present) so an empty
    // note never lands on the persisted record.
    result = trustApprove({ projectRoot, ...(note !== undefined ? { note } : {}) }, { homeDir });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const stdout = wantJson ? stableStringify(result) : renderHuman(result);
  return { stdout, stderr: '', code: EXIT_OK };
}

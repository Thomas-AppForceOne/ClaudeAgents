/**
 * R5 sprint 4 — `gan trust approve --project-root DIR [--note TEXT] [--json]`.
 *
 * Calls R1's `trustApprove({projectRoot, note}, {homeDir})` in-process.
 * `--project-root` is REQUIRED for trust-mutating subcommands (per the
 * R3-locked CLI surface): the command exits 64 if the flag is absent.
 * HOME is read from `process.env.HOME ?? os.homedir()`.
 *
 * Exit codes:
 *   - 0  success (record persisted to the trust cache).
 *   - 1  generic failure (e.g. trust cache I/O error).
 *   - 5  framework library unreachable.
 *   - 64 bad CLI arguments (missing `--project-root`).
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

function renderHuman(r: ApproveResultLike): string {
  return `Approved ${r.record.projectRoot} with hash ${r.record.aggregateHash}\n`;
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

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

  const homeDir = process.env.HOME ?? os.homedir();
  const noteFlag = parsed.flags['note'];
  const note = typeof noteFlag === 'string' && noteFlag.length > 0 ? noteFlag : undefined;

  let result: ApproveResultLike;
  try {
    result = trustApprove({ projectRoot, ...(note !== undefined ? { note } : {}) }, { homeDir });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const stdout = wantJson ? stableStringify(result) : renderHuman(result);
  return { stdout, stderr: '', code: EXIT_OK };
}

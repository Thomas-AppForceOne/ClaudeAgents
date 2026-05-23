/**
 * `gan trust list` — list every trust approval recorded in the user-tier trust
 * cache, across all projects. Read-only and project-independent: it takes no
 * `--project-root` (the cache is global to the user's home).
 */

import os from 'node:os';

import { trustList } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { errorResult, type CommandResult } from '../lib/run-helpers.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * One recorded approval as rendered by this command.
 *
 * @property projectRoot the (canonical) project the approval is for.
 * @property aggregateHash the config hash pinned at approval time.
 * @property approvedAt ISO-8601 approval timestamp.
 * @property approvedCommit git HEAD at approval; optional provenance.
 * @property note optional free-text annotation.
 */
interface ApprovalLike {
  projectRoot: string;
  aggregateHash: string;
  approvedAt: string;
  approvedCommit?: string;
  note?: string;
}

/**
 * Shape returned by `trustList`.
 *
 * @property approvals every recorded approval; empty when none exist.
 */
interface TrustListResultLike {
  approvals: ApprovalLike[];
}

/**
 * Render the approval list for human (non-JSON) output.
 *
 * @param r the trust-list result.
 * @returns an indented block per approval (trailing newline); the optional
 *   `commit` and `note` lines are emitted only when present (an empty note is
 *   treated as absent). Empty list → a fixed `No trust approvals found.`
 *   notice.
 */
function renderHuman(r: TrustListResultLike): string {
  if (r.approvals.length === 0) {
    return 'No trust approvals found.\n';
  }
  const lines: string[] = [];
  for (const a of r.approvals) {
    lines.push(`- ${a.projectRoot}`);
    lines.push(`    hash:        ${a.aggregateHash}`);
    lines.push(`    approved at: ${a.approvedAt}`);
    if (a.approvedCommit !== undefined) {
      lines.push(`    commit:      ${a.approvedCommit}`);
    }
    if (a.note !== undefined && a.note.length > 0) {
      lines.push(`    note:        ${a.note}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan trust list`.
 *
 * @param parsed parsed argv; honours `--json`.
 * @returns a {@link CommandResult}; exit {@link EXIT_OK} with the listing on
 *   `stdout`, or an {@link errorResult}-mapped failure if the cache read
 *   throws (e.g. a corrupt trust cache). The `--json` form is deterministically
 *   serialised via `stableStringify`.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  // HOME wins over os.homedir() so the trust-cache location is overridable.
  const homeDir = process.env.HOME ?? os.homedir();

  let result: TrustListResultLike;
  try {
    result = trustList({}, { homeDir });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const stdout = wantJson ? stableStringify(result) : renderHuman(result);
  return { stdout, stderr: '', code: EXIT_OK };
}

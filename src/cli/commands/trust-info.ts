/**
 * `gan trust info` — report the trust state of a project: whether it is
 * approved, its current aggregate config hash, and (when approved) the pinned
 * approval details. Read-only; unlike the trust-*mutating* subcommands it does
 * not require `--project-root` and falls back to the current directory.
 */

import os from 'node:os';

import { getTrustState } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Local structural view of the trust state returned by `getTrustState` (only
 * the fields this command renders).
 *
 * @property approved whether the project currently has a valid approval.
 * @property currentHash the aggregate config hash computed now.
 * @property approvedHash the hash pinned at approval time; present only when
 *   approved. A mismatch with `currentHash` means the config changed since.
 * @property approvedAt ISO-8601 approval timestamp; present only when approved.
 * @property approvedCommit git HEAD captured at approval; optional even when
 *   approved (best-effort provenance).
 * @property summary optional counts of additional checks and per-stack
 *   overrides at approval time.
 */
interface TrustStateLike {
  approved: boolean;
  currentHash: string;
  approvedHash?: string;
  approvedAt?: string;
  approvedCommit?: string;
  summary?: { additionalChecksCount: number; perStackOverridesCount: number };
}

/**
 * Render the trust state for human (non-JSON) output.
 *
 * @param state the trust state to render.
 * @returns aligned label lines (trailing newline). Optional fields
 *   (`approvedHash`, `approvedAt`, `approvedCommit`, `summary`) are emitted
 *   only when present, so an unapproved project prints just the approved/hash
 *   pair.
 */
function renderHuman(state: TrustStateLike): string {
  const lines: string[] = [];
  lines.push(`Approved: ${state.approved ? 'yes' : 'no'}`);
  lines.push(`Current hash: ${state.currentHash}`);
  if (state.approvedHash !== undefined) {
    lines.push(`Approved hash: ${state.approvedHash}`);
  }
  if (state.approvedAt !== undefined) {
    lines.push(`Approved at: ${state.approvedAt}`);
  }
  if (state.approvedCommit !== undefined) {
    lines.push(`Approved commit: ${state.approvedCommit}`);
  }
  if (state.summary !== undefined) {
    lines.push(
      `Summary: ${state.summary.additionalChecksCount} additionalChecks, ` +
        `${state.summary.perStackOverridesCount} per-stack overrides`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan trust info`.
 *
 * @param parsed parsed argv; honours `--json` and an optional `--project-root`
 *   (defaults to cwd, since reading trust state is non-mutating).
 * @returns a {@link CommandResult}; exit {@link EXIT_OK} with the state on
 *   `stdout`, or an {@link errorResult}-mapped failure if project-root
 *   resolution or the trust-state read throws (e.g. a corrupt trust cache).
 *   The `--json` form is deterministically serialised via `stableStringify`.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  // The trust cache lives under the user's home; HOME wins over os.homedir()
  // so tests (and overridden environments) can redirect it.
  const homeDir = process.env.HOME ?? os.homedir();

  let state: TrustStateLike;
  try {
    state = getTrustState({ projectRoot }, { homeDir });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const stdout = wantJson ? stableStringify(state) : renderHuman(state);
  return { stdout, stderr: '', code: EXIT_OK };
}

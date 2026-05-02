/**
 * R5 sprint 4 — `gan trust info [--project-root DIR] [--json]`.
 *
 * Calls R1's `getTrustState({projectRoot}, {homeDir})` in-process (per
 * the CLI-imports-library rule). Renders the approval state in either
 * a short human-readable summary or as deterministic JSON.
 *
 * `--project-root` defaults to the canonicalised form of the current
 * working directory (per R3's project-root helper). HOME is read from
 * `process.env.HOME ?? os.homedir()` so tests can drive the cache via
 * a `mkdtempSync` directory without touching the real `~/.claude/gan/`.
 *
 * Exit codes:
 *   - 0  success.
 *   - 1  trust cache unreadable / corrupt (`TrustCacheCorrupt` from R1).
 *   - 5  framework library unreachable.
 *   - 64 bad CLI arguments (e.g. `--project-root` set to a non-directory).
 */

import os from 'node:os';

import { getTrustState } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface TrustStateLike {
  approved: boolean;
  currentHash: string;
  approvedHash?: string;
  approvedAt?: string;
  approvedCommit?: string;
  summary?: { additionalChecksCount: number; perStackOverridesCount: number };
}

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

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

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

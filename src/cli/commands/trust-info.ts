

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

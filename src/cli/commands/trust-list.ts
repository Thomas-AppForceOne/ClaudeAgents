

import os from 'node:os';

import { trustList } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { errorResult, type CommandResult } from '../lib/run-helpers.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface ApprovalLike {
  projectRoot: string;
  aggregateHash: string;
  approvedAt: string;
  approvedCommit?: string;
  note?: string;
}

interface TrustListResultLike {
  approvals: ApprovalLike[];
}

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

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
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

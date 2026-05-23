

import { getActiveStacks } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

interface ActiveStacksResponse {
  active: string[];
}

function renderHuman(resp: ActiveStacksResponse): string {
  if (resp.active.length === 0) return '(none)\n';
  return resp.active.join('\n') + '\n';
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(
    parsed,
    (projectRoot) => Promise.resolve(getActiveStacks({ projectRoot })),
    renderHuman,
  );
}

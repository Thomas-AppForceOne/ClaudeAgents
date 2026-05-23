

import { listModules } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

interface ListModulesResponse {
  modules: string[];
}

function renderHuman(resp: ListModulesResponse): string {
  if (resp.modules.length === 0) {
    return 'No modules registered (M1 not yet implemented).\n';
  }
  return resp.modules.join('\n') + '\n';
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(
    parsed,
    (projectRoot) => Promise.resolve(listModules({ projectRoot })),
    renderHuman,
  );
}

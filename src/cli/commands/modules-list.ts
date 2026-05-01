/**
 * R3 sprint 2 — `gan modules list [--json] [--project-root DIR]`.
 *
 * Calls R1's `listModules({projectRoot})` in-process. Per the OQ4 no-op
 * contract (R1-locked), the function returns an empty list until M1
 * ships. The CLI prints a short pre-M1 marker in the human surface; the
 * JSON surface emits the response object verbatim (`{"modules":[]}`).
 *
 * Once M1 lands, the JSON surface stays stable — the human renderer
 * picks up actual module names automatically.
 */

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

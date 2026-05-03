/**
 * R3 sprint 2 — `gan stacks list [--json] [--project-root DIR]`.
 *
 * Calls R1's `getActiveStacks({projectRoot})` in-process. Output:
 *   - human: one stack name per line; empty active set prints "(none)".
 *   - JSON: emits the response object verbatim (`{"active":["..."]}`)
 *     through `emitJson` (sorted keys, two-space indent, trailing newline).
 *
 * Active-set semantics are owned by C2 dispatch (via R1); the CLI only
 * surfaces the result.
 */

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

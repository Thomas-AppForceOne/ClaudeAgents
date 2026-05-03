/**
 * R3 sprint 2 — `gan stack show <name> [--json] [--project-root DIR]`.
 *
 * Calls R1's `getStack({projectRoot, name})` in-process. The response
 * shape (per `src/config-server/tools/reads.ts`):
 *
 *   { data, prose: { before, after }, sourceTier, sourcePath }
 *
 * Tier provenance (`sourceTier` / `sourcePath`) is included in both
 * surfaces per the contract: human format prints a header line that names
 * the tier and the resolved path; `--json` emits the response verbatim.
 */

import { getStack } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { EXIT_BAD_ARGS } from '../lib/exit-codes.js';
import { readSharedFlags, runRead } from '../lib/run-helpers.js';
import type { CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

interface StackResponse {
  data: unknown;
  prose: { before: string; after: string };
  sourceTier: 'project' | 'user' | 'builtin';
  sourcePath: string;
}

function renderHuman(resp: StackResponse): string {
  const lines: string[] = [];
  lines.push(`source tier: ${resp.sourceTier}`);
  lines.push(`source path: ${resp.sourcePath}`);
  lines.push('');
  lines.push('data:');
  // Reuse the deterministic JSON shape for the data block so structured
  // values (arrays, nested objects) render identically across runs and
  // align byte-for-byte with the `--json` surface. Routes through R1's
  // `stableStringify` (sorted keys + two-space indent, per F3 determinism);
  // trim the trailing newline since we're embedding mid-output.
  const dataJson = stableStringify(resp.data).trimEnd();
  for (const ln of dataJson.split('\n')) lines.push(`  ${ln}`);
  return lines.join('\n') + '\n';
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson } = readSharedFlags(parsed);
  const name = parsed._[0];
  if (name === undefined || name.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan stack show requires a stack name argument.',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }

  return runRead(parsed, async (projectRoot) => getStack({ projectRoot, name }), renderHuman);
}

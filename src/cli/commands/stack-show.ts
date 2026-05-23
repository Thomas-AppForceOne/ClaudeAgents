/**
 * `gan stack show <name>` — print the resolved contents of a single named
 * stack: which tier it resolved from, its on-disk path, and its data body.
 *
 * Read-only. The required stack-name argument is validated here (a bad-args
 * error if absent); everything else — project-root resolution, `--json`
 * handling, and error mapping — is delegated to {@link runRead}.
 */

import { getStack } from '../../index.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { EXIT_BAD_ARGS } from '../lib/exit-codes.js';
import { readSharedFlags, runRead } from '../lib/run-helpers.js';
import type { CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Shape returned by `getStack`.
 *
 * @property data the stack's parsed data body (arbitrary YAML mapping).
 * @property prose the markdown prose surrounding the data block, split into
 *   the text `before` and `after` it.
 * @property sourceTier which tier the stack resolved from (`project` and
 *   `user` customizations win over the `builtin` default).
 * @property sourcePath the absolute path of the file that supplied it.
 */
interface StackResponse {
  data: unknown;
  prose: { before: string; after: string };
  sourceTier: 'project' | 'user' | 'builtin';
  sourcePath: string;
}

/**
 * Render a resolved stack for human (non-JSON) output.
 *
 * @param resp the resolved stack.
 * @returns the source tier and path, then a `data:` block holding the
 *   deterministically-serialised data body indented two spaces (trailing
 *   newline). Prose is intentionally omitted from the human view.
 */
function renderHuman(resp: StackResponse): string {
  const lines: string[] = [];
  lines.push(`source tier: ${resp.sourceTier}`);
  lines.push(`source path: ${resp.sourcePath}`);
  lines.push('');
  lines.push('data:');

  // stableStringify for determinism; indent every line two spaces to nest it
  // under the `data:` header.
  const dataJson = stableStringify(resp.data).trimEnd();
  for (const ln of dataJson.split('\n')) lines.push(`  ${ln}`);
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan stack show`.
 *
 * @param parsed parsed argv; the first positional is the required stack name,
 *   and `--json` / `--project-root` are honoured.
 * @returns a {@link CommandResult}. A missing/empty name is `MalformedInput`
 *   with exit {@link EXIT_BAD_ARGS}; otherwise {@link runRead} resolves the
 *   stack and maps any failure (e.g. unknown stack) to an error result.
 */
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

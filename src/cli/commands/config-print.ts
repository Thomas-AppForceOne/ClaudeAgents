/**
 * `gan config print` — print a human-readable summary of the fully resolved
 * config for a project (api/schema versions, active stacks, discarded paths,
 * additional-context registrations, and the issue count).
 *
 * A read-only command: it never writes and delegates project-root resolution,
 * `--json` handling, and error mapping to {@link runRead}. The `--json` form
 * emits the entire resolved-config object; the human form is the curated
 * subset rendered by {@link renderHuman}.
 */

import { getResolvedConfig } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ResolvedConfig } from '../../index.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Render the curated, human-readable summary of a resolved config.
 *
 * @param resolved the fully resolved config to summarise.
 * @returns aligned `key: value` lines (trailing newline). `(none)` stands in
 *   for empty stack / discarded lists, and `additionalContext` is reduced to
 *   the registration `path`s for the planner and proposer roles.
 */
function renderHuman(resolved: ResolvedConfig): string {
  const lines: string[] = [];
  lines.push(`apiVersion:        ${resolved.apiVersion}`);
  lines.push(
    `schemaVersions:    stack=${resolved.schemaVersions.stack} overlay=${resolved.schemaVersions.overlay}`,
  );
  const active = resolved.stacks.active;
  lines.push(`active stacks:     ${active.length === 0 ? '(none)' : active.join(', ')}`);
  lines.push(
    `discarded paths:   ${resolved.discarded.length === 0 ? '(none)' : resolved.discarded.join(', ')}`,
  );
  const plannerCtx = resolved.additionalContext.planner.map((r) => r.path);
  const proposerCtx = resolved.additionalContext.proposer.map((r) => r.path);
  lines.push(
    `additionalContext: planner=[${plannerCtx.join(', ')}] proposer=[${proposerCtx.join(', ')}]`,
  );
  lines.push(`issues:            ${resolved.issues.length}`);
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan config print`.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root` via
 *   {@link runRead}.
 * @returns a {@link CommandResult}; exit OK on success or an error-mapped code
 *   if project-root resolution / config resolution throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(parsed, (projectRoot) => getResolvedConfig({ projectRoot }), renderHuman);
}

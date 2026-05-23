

import { getResolvedConfig } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ResolvedConfig } from '../../index.js';
import type { ParsedArgs } from '../lib/args.js';

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

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(parsed, (projectRoot) => getResolvedConfig({ projectRoot }), renderHuman);
}

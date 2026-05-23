

import { type Issue } from './schema-check.js';

const FORBIDDEN_FIELDS: ReadonlyArray<{

  field: string;

  block: 'planner' | 'proposer' | 'stack';

  leaf: 'additionalContext' | 'cacheEnvOverride' | 'override';

  reason: string;
}> = [
  {
    field: 'planner.additionalContext',
    block: 'planner',
    leaf: 'additionalContext',
    reason: 'Paths declared here are project-relative and have no meaning at user scope.',
  },
  {
    field: 'proposer.additionalContext',
    block: 'proposer',
    leaf: 'additionalContext',
    reason: 'Paths declared here are project-relative and have no meaning at user scope.',
  },
  {
    field: 'stack.cacheEnvOverride',
    block: 'stack',
    leaf: 'cacheEnvOverride',
    reason:
      "Each entry targets a specific project's stack environment; the right value depends on the project's worktree paths and tooling, not the user's preference.",
  },
  {
    field: 'stack.override',
    block: 'stack',
    leaf: 'override',
    reason:
      'Per C2, any non-empty value replaces auto-detection — at user tier this would silently disable auto-detection in every project the user touches.',
  },
];

export function checkUserOverlayForbiddenFields(
  filePath: string,
  data: unknown,
  issues: Issue[],
): void {
  if (!isObject(data)) return;

  for (const entry of FORBIDDEN_FIELDS) {
    const block = data[entry.block];
    if (!isObject(block)) continue;
    if (!Object.prototype.hasOwnProperty.call(block, entry.leaf)) continue;
    issues.push({
      code: 'MalformedInput',
      path: filePath,
      field: entry.field,
      message:
        `The user overlay at '${filePath}' declares '${entry.field}', ` +
        `which is forbidden at user tier by ClaudeAgents (the framework). ` +
        `${entry.reason} Move this declaration to the project overlay at ` +
        `'.claude/gan/project.md'.`,
      severity: 'error',
    });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

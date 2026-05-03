/**
 * User-tier forbidden field check (per C3 lines 71-75).
 *
 * A user overlay (`~/.claude/gan/user.md`) declaring any of the four
 * tier-forbidden fields is a hard error at load and at write time:
 *
 *  - `planner.additionalContext`
 *  - `proposer.additionalContext`
 *  - `stack.override`
 *  - `stack.cacheEnvOverride`
 *
 * The check is **key-presence** based — declaring the key with an empty
 * value still fires the issue. Each forbidden field present in `data`
 * produces one `MalformedInput` issue; multiple forbidden fields produce
 * multiple issues, in deterministic alphabetical order:
 *   `planner.additionalContext`,
 *   `proposer.additionalContext`,
 *   `stack.cacheEnvOverride`,
 *   `stack.override`.
 *
 * This invariant is owned by the schema-vs-tier separation rule (C3 + F3):
 * the JSON Schema permits these fields unconditionally; the tier gate is
 * upstream, in this loader-time check.
 */

import { type Issue } from './schema-check.js';

/** Forbidden field paths in the canonical alphabetical order. */
const FORBIDDEN_FIELDS: ReadonlyArray<{
  /** Canonical dotted path used in the issue's `field` and message. */
  field: string;
  /** Top-level YAML key. */
  block: 'planner' | 'proposer' | 'stack';
  /** Sub-key under the block. */
  leaf: 'additionalContext' | 'cacheEnvOverride' | 'override';
  /** Per-field rationale (mirrors C3 lines 72-74). */
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

/**
 * Inspect a user-tier overlay's parsed data for tier-forbidden fields and
 * append one `MalformedInput` issue per declared field. The check is a
 * no-op if `data` is null, undefined, or not a plain object.
 */
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

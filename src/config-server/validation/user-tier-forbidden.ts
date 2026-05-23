/**
 * Enforces the fields that are forbidden specifically at the *user* overlay
 * tier.
 *
 * The user overlay applies to every project the user touches, so settings
 * whose meaning is inherently project-local (relative paths, per-project stack
 * environments, detection overrides) must not be set there — they would either
 * be meaningless or silently misbehave across unrelated projects. The schema
 * cannot express this (the same fields are valid at the project tier), so it
 * is a separate gate run only on the user tier, layered on top of normal
 * schema validation.
 */

import { type Issue } from './schema-check.js';

// The forbidden user-tier fields, each with the precise reason it is rejected
// (surfaced verbatim to the user). `block`/`leaf` locate the field in the
// parsed document; `field` is the dotted name shown in the message.
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

/**
 * Append an {@link Issue} for each forbidden field present in a *user*-tier
 * overlay document. Call this only for the user tier — the same fields are
 * legitimate at project tier.
 *
 * @param filePath absolute path of the user overlay, used in the issue's
 *   `path` and message.
 * @param data the parsed overlay body. A non-object (e.g. empty/null body) is
 *   silently ignored — there is nothing to forbid.
 * @param issues accumulator mutated in place; one issue is appended per
 *   forbidden field found (code `MalformedInput`, severity `error`). Detection
 *   is by mere *presence* of the leaf key, regardless of its value, so even an
 *   empty list at a forbidden path is rejected.
 *
 * Does not throw and does not return a value — failures are reported only by
 * pushing into `issues`.
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
    // Presence alone is the violation — `hasOwnProperty`, not a truthiness
    // check — so declaring the field even with an empty value is rejected.
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

// Local plain-object guard: true only for non-null, non-array objects (the
// shape of a parsed YAML mapping / overlay block).
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

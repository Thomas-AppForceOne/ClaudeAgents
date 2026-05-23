/**
 * Invariant `detection.tier3_only`: a `detection` block may appear only in
 * built-in (tier-3) stack files.
 *
 * Detection patterns decide which stacks auto-activate for a project, so they
 * are framework-owned and must ship in the built-in tier. Project- and
 * user-tier files exist to *customise the contents* of a stack, not to invent
 * new activation rules — a project that wants a stack on regardless uses
 * `stack.override` in its overlay instead. A `detection` block in a non-builtin
 * file is therefore an `error`.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/**
 * Flag any project- or user-tier stack that declares a `detection` block.
 *
 * Reads only `snapshot.stackFiles`; pure and never throws on a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns one `error` {@link Issue} per offending non-builtin stack, in stable
 *   sort order; built-in stacks and stacks without a `detection` key produce
 *   none. Mere *presence* of the key is the trigger — its value is not
 *   inspected.
 */
export function checkDetectionTier3Only(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    // Built-in stacks are the only tier allowed to own detection rules.
    if (row.tier === 'builtin') continue;
    if (!row.data || !isObject(row.data)) continue;
    if (!('detection' in row.data)) continue;
    issues.push(buildIssue(row));
  }
  return issues;
}

/**
 * Build the error issue for a non-builtin stack that carries a `detection`
 * block, tailoring the tier label (project vs. user) and pointing at the fix
 * (remove the block; use `stack.override` to force activation).
 *
 * @param row the offending stack row; its `tier` selects the label and its
 *   `path` is the reported location.
 */
function buildIssue(row: SnapshotStackRow): Issue {
  const tierLabel = row.tier === 'project' ? 'project-tier' : 'user-tier';
  const messageBody =
    `Stack file '${row.path}' is a ${tierLabel} file but declares a 'detection' block. ` +
    `Detection rules are only allowed in built-in (tier-3) stack files; ` +
    `${tierLabel} files customise stack contents but never introduce new ` +
    `detection patterns. Remove the 'detection' block from the file. To force ` +
    `this stack to activate for a project, add its name to 'stack.override' ` +
    `in your project overlay (.claude/gan/project.md).`;
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: '/detection',
    message: err.message,
    severity: 'error',
  };
}

/**
 * Return the snapshot's stack rows in a deterministic order, sorted by their
 * map key (tier-prefixed path), so the emitted issues are ordered the same way
 * on every run.
 */
function orderedStackRows(snapshot: ValidationSnapshot): SnapshotStackRow[] {
  const keys = Array.from(snapshot.stackFiles.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }),
  );
  const out: SnapshotStackRow[] = [];
  for (const k of keys) {
    const row = snapshot.stackFiles.get(k);
    if (row) out.push(row);
  }
  return out;
}

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

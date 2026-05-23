

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

export function checkDetectionTier3Only(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    if (row.tier === 'builtin') continue;
    if (!row.data || !isObject(row.data)) continue;
    if (!('detection' in row.data)) continue;
    issues.push(buildIssue(row));
  }
  return issues;
}

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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

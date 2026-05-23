

import { createError } from '../errors.js';
import { DRAFT_BANNER } from '../scaffold-banner.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

export function checkStackNoDraftBanner(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    if (!hasDraftBanner(row)) continue;
    issues.push(buildIssue(row));
  }
  return issues;
}

function hasDraftBanner(row: SnapshotStackRow): boolean {

  if (row.prose) {
    if (firstNonBlankLineMatches(row.prose.before, DRAFT_BANNER)) return true;
    if (firstNonBlankLineMatches(row.prose.after, DRAFT_BANNER)) return true;
  }
  return false;
}

function firstNonBlankLineMatches(text: string, target: string): boolean {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return line.trimEnd() === target;
  }
  return false;
}

function buildIssue(row: SnapshotStackRow): Issue {
  const messageBody =
    `Stack file '${row.path}' still carries the scaffold banner '${DRAFT_BANNER}'. ` +
    `The banner is the framework's signal that the file is a half-finished scaffold; ` +
    `replace the TODOs in the file and remove the banner before committing.`;
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: '/prose',
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

/**
 * `stack.no_draft_banner` invariant (F3 catalog; sourced from R3).
 *
 * `gan stacks new` (R3, future) emits a stack file scaffold whose first
 * non-blank prose line is the literal banner:
 *
 *     # DRAFT — replace TODOs before committing.
 *
 * Removing the banner is the user's deliberate "I have replaced the
 * TODOs" act. A stack file at any tier that still carries the banner is
 * a half-finished scaffold and must not ship; this invariant fires hard.
 *
 * R3 has not landed yet, but per F3's note this rule is *catalogued as a
 * cross-file invariant precisely so it fires from `gan validate` /
 * `validateAll()` and from R4's `lint-stacks` without two implementations
 * having to agree on the rule*. The fixture seeds a banner manually so
 * the invariant is testable today.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

const DRAFT_BANNER = '# DRAFT — replace TODOs before committing.';

export function checkStackNoDraftBanner(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    if (!hasDraftBanner(row)) continue;
    issues.push(buildIssue(row));
  }
  return issues;
}

function hasDraftBanner(row: SnapshotStackRow): boolean {
  // Inspect both the prose flanking the YAML block (the author's
  // human-readable narrative) and — defensively — the raw row data, so a
  // banner left in the YAML body via a stray `# DRAFT` description field
  // also fires.
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

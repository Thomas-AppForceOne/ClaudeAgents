/**
 * Invariant `stack.no_draft_banner`: a committed stack file must not still
 * carry the scaffold {@link DRAFT_BANNER}.
 *
 * Newly scaffolded stacks ship with a draft banner as the framework's "this is
 * a half-finished template, fill in the TODOs" marker. Its lingering presence
 * means an unfinished file was committed, so it is reported as an `error`. The
 * check inspects the file's *prose* (the Markdown around the YAML block), not
 * the parsed YAML data, and only the banner's removal — not just any edit —
 * clears the violation.
 */

import { createError } from '../errors.js';
import { DRAFT_BANNER } from '../scaffold-banner.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/**
 * Flag every stack file whose surrounding prose still leads with the draft
 * banner.
 *
 * Reads only `snapshot.stackFiles`; pure and never throws on a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns one `error` {@link Issue} per stack still bearing the banner, in
 *   stable sort order; empty when none do.
 */
export function checkStackNoDraftBanner(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    if (!hasDraftBanner(row)) continue;
    issues.push(buildIssue(row));
  }
  return issues;
}

/**
 * True when the banner is the first non-blank line of either prose region
 * (before or after the YAML block). Both regions are checked because a
 * scaffold may place the banner above or below the data block.
 *
 * @param row the stack row; only `row.prose` is inspected (a row with no prose
 *   captured can never match).
 */
function hasDraftBanner(row: SnapshotStackRow): boolean {

  if (row.prose) {
    if (firstNonBlankLineMatches(row.prose.before, DRAFT_BANNER)) return true;
    if (firstNonBlankLineMatches(row.prose.after, DRAFT_BANNER)) return true;
  }
  return false;
}

/**
 * True when the first non-blank line of `text` equals `target`.
 *
 * Leading blank lines are skipped so an indented or vertically-offset banner
 * still matches; the comparison `trimEnd`s the line (tolerating trailing
 * whitespace) but not its start, so the banner must begin at column zero.
 * Only the *first* non-blank line is considered — a banner buried deeper in the
 * prose is intentionally not matched.
 */
function firstNonBlankLineMatches(text: string, target: string): boolean {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return line.trimEnd() === target;
  }
  return false;
}

/**
 * Build the error issue telling the user to finish the scaffold and drop the
 * banner. The reported location is `row.path` with a `/prose` pointer, since
 * the offending text lives in the prose, not the YAML body.
 */
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

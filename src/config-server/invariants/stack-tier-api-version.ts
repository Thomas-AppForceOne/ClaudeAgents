/**
 * Invariant `stack.tier_apiVersion`: every stack file (any tier) must declare
 * `schemaVersion: 1`, the only stack schema this framework version understands.
 *
 * The stack-file counterpart of `overlay.tier_apiVersion`. A missing or wrong
 * version means the file targets a different framework version, so it is an
 * `error`; the two cases get distinct messages (add vs. change the field). A
 * non-mapping body is left to schema validation.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

// The sole stack schema version this framework build accepts; see the overlay
// counterpart for the bump-vs-edit rule.
const EXPECTED_STACK_SCHEMA_VERSION = 1;

/**
 * Check the declared `schemaVersion` of every stack file in the snapshot.
 *
 * Reads only `snapshot.stackFiles`; pure and never throws on a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns one `error` {@link Issue} per stack whose `schemaVersion` is absent
 *   or not exactly `1`, in stable sort order; empty when all match. Stacks
 *   whose body is not a mapping are skipped (schema validation owns those).
 */
export function checkStackTierApiVersion(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const row of orderedStackRows(snapshot)) {
    if (!row.data || !isObject(row.data)) continue;
    const declared = row.data['schemaVersion'];
    if (declared === EXPECTED_STACK_SCHEMA_VERSION) continue;
    issues.push(buildIssue(row, declared));
  }
  return issues;
}

/**
 * Build the version issue for a stack file, with "missing" vs. "mismatch"
 * wording as in the overlay check.
 *
 * @param row the stack row; its `path` is the reported location.
 * @param declared the raw `schemaVersion` read from the body (`undefined` when
 *   absent).
 */
function buildIssue(row: SnapshotStackRow, declared: unknown): Issue {
  const messageBody =
    declared === undefined
      ? `Stack file '${row.path}' is missing 'schemaVersion'. The framework only ` +
        `accepts stack files declaring 'schemaVersion: ${EXPECTED_STACK_SCHEMA_VERSION}'. ` +
        `Add 'schemaVersion: ${EXPECTED_STACK_SCHEMA_VERSION}' at the top of the YAML body.`
      : `Stack file '${row.path}' declares schemaVersion=${JSON.stringify(declared)} but the ` +
        `framework only supports schemaVersion=${EXPECTED_STACK_SCHEMA_VERSION}. Update the ` +
        `file's 'schemaVersion' field to ${EXPECTED_STACK_SCHEMA_VERSION}.`;
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: '/schemaVersion',
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

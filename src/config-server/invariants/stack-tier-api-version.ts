/**
 * `stack.tier_apiVersion` invariant (F3 catalog; sourced from C1).
 *
 * Each active stack file's `schemaVersion` must match the API's known
 * stack schema version. Today the only known version is 1; mismatches
 * surface as an `InvariantViolation` issue (per S4's "no new error
 * codes" rule).
 *
 * Phase 2 already raises a `SchemaMismatch` issue per ajv when a stack
 * file's `schemaVersion` is wrong; this invariant is the cross-tier
 * sanity backstop — it ensures every stack file at every tier the
 * framework saw during phase 1 carries the expected API version, even
 * if a future phase 2 path lets one through. The catalog entry exists
 * because F3 owns the cross-file invariants list; deferring to phase 2
 * would couple the catalog to an implementation detail.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

const EXPECTED_STACK_SCHEMA_VERSION = 1;

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

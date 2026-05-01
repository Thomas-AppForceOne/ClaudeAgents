/**
 * `overlay.tier_apiVersion` invariant (F3 catalog; sourced from C3).
 *
 * Each overlay tier's `schemaVersion` must match the API's known overlay
 * schema version. Today the only known version is 1; mismatches surface
 * as an `InvariantViolation` issue (per S4's "no new error codes" rule).
 *
 * Phase 2 already raises a `SchemaMismatch` issue per ajv when the
 * overlay's `schemaVersion` is wrong, so this invariant is effectively a
 * cross-tier sanity backstop — it ensures *every* loaded overlay
 * (default, user, project) carries the expected API version even if a
 * future phase 2 path lets one through. The catalog entry exists because
 * F3 owns the cross-file invariants list; deferring to phase 2 would
 * couple the catalog to an implementation detail.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

const EXPECTED_OVERLAY_SCHEMA_VERSION = 1;

export function checkOverlayTierApiVersion(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    if (!isObject(row.data)) continue;
    const declared = row.data['schemaVersion'];
    if (declared === EXPECTED_OVERLAY_SCHEMA_VERSION) continue;
    issues.push(buildIssue(row, declared));
  }
  return issues;
}

function buildIssue(row: SnapshotOverlayRow, declared: unknown): Issue {
  const messageBody =
    declared === undefined
      ? `Overlay '${row.path}' is missing 'schemaVersion'. The framework only ` +
        `accepts overlay files declaring 'schemaVersion: ${EXPECTED_OVERLAY_SCHEMA_VERSION}'. ` +
        `Add 'schemaVersion: ${EXPECTED_OVERLAY_SCHEMA_VERSION}' at the top of the YAML body.`
      : `Overlay '${row.path}' declares schemaVersion=${JSON.stringify(declared)} but the ` +
        `framework only supports schemaVersion=${EXPECTED_OVERLAY_SCHEMA_VERSION}. Update the ` +
        `file's 'schemaVersion' field to ${EXPECTED_OVERLAY_SCHEMA_VERSION}.`;
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: '/schemaVersion',
    message: err.message,
    severity: 'error',
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

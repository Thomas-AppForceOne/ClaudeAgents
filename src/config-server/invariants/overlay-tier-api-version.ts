/**
 * Invariant `overlay.tier_apiVersion`: every overlay document must declare
 * `schemaVersion: 1`, the only overlay schema this framework version
 * understands.
 *
 * A wrong or missing version means the file was written for a different
 * framework version and its other fields cannot be trusted, so this is an
 * `error`. Missing and mismatched get distinct messages (add the field vs.
 * change it). A non-mapping body is left to schema validation — this invariant
 * only judges the version field once a body exists.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

// The sole overlay schema version this framework build accepts. Bumping the
// on-disk format means introducing a new version and a migration, not editing
// this constant.
const EXPECTED_OVERLAY_SCHEMA_VERSION = 1;

/**
 * Check the declared `schemaVersion` of every present overlay tier.
 *
 * Reads only `snapshot.overlays`; pure and never throws on a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns one `error` {@link Issue} per overlay whose `schemaVersion` is
 *   absent or not exactly `1`; empty when all present overlays match. Overlays
 *   whose body is not a mapping are skipped (schema validation reports those).
 */
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

/**
 * Build the version-mismatch issue, choosing the "missing" wording when no
 * version was declared and the "mismatch" wording (echoing the bad value) when
 * one was declared but is wrong.
 *
 * @param row the overlay row; its `path` is the reported location.
 * @param declared the raw `schemaVersion` value read from the body
 *   (`undefined` when the key is absent).
 */
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

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

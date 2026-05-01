/**
 * `path.no_escape` invariant (F3 catalog; sourced from F4).
 *
 * Every path declared in any committed config file must resolve to a real
 * path that is a descendant of the project root. Today the path-bearing
 * splice points are `proposer.additionalContext` and
 * `planner.additionalContext` (per U3 / C3). Future splice points carrying
 * filesystem paths must extend the inspected fields below.
 *
 * Hard error (`PathEscape` semantics, surfaced under the F2
 * `InvariantViolation` issue code per S4's "no new codes" rule). The check
 * uses `determinism.canonicalizePath` for both the root and the candidate
 * so symlinks, trailing slashes, and case-sensitive-filesystem differences
 * resolve consistently with the rest of the framework (F3 determinism
 * pin).
 */

import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

const PATH_BEARING_FIELDS: Array<{ block: 'proposer' | 'planner'; field: 'additionalContext' }> = [
  { block: 'proposer', field: 'additionalContext' },
  { block: 'planner', field: 'additionalContext' },
];

export function checkPathNoEscape(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  const canonRoot = canonicalizePath(snapshot.projectRoot);
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    for (const field of PATH_BEARING_FIELDS) {
      const candidates = extractPaths(row.data, field.block, field.field);
      for (const candidate of candidates) {
        if (!escapesRoot(candidate, snapshot.projectRoot, canonRoot)) continue;
        issues.push(buildIssue(row, field.block, field.field, candidate));
      }
    }
  }
  return issues;
}

function buildIssue(
  row: SnapshotOverlayRow,
  block: string,
  field: string,
  candidate: string,
): Issue {
  const messageBody =
    `Overlay '${row.path}' declares ${block}.${field} entry '${candidate}', ` +
    `which resolves outside the project root. The framework only reads files ` +
    `that live underneath the project root. Edit the overlay so this entry ` +
    `points at a path inside the project, or remove the entry.`;
  // Funnel through the central factory so the wording lives alongside
  // other path-escape messaging if a dedicated factory branch is added.
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: `/${block}/${field}`,
    message: err.message,
    severity: 'error',
  };
}

/**
 * Determine whether a candidate path escapes the project root. A path is
 * "escaping" if its canonical form does not start with the canonical root
 * (with a path-separator or end-of-string boundary, so `/proj` does not
 * match `/projfoo`).
 */
function escapesRoot(candidate: string, projectRoot: string, canonRoot: string): boolean {
  // Resolve candidate relative to the project root if it is not already
  // absolute. `path.resolve` preserves an absolute candidate as-is.
  const absoluteCandidate = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(projectRoot, candidate);
  const canonCandidate = canonicalizePath(absoluteCandidate);
  if (canonCandidate === canonRoot) return false;
  const sep = path.sep;
  // Boundary-aware prefix check: `${root}${sep}` ensures `/a/b` is not
  // treated as a prefix of `/a/bc`. We also test the alternate separator
  // because `canonicalizePath` may lowercase but does not normalise
  // separators on Windows; on POSIX `sep` is `/` and the alternate test
  // is a no-op.
  const altSep = sep === '/' ? '\\' : '/';
  if (canonCandidate.startsWith(canonRoot + sep)) return false;
  if (canonCandidate.startsWith(canonRoot + altSep)) return false;
  return true;
}

function extractPaths(
  data: unknown,
  block: 'proposer' | 'planner',
  field: 'additionalContext',
): string[] {
  if (!isObject(data)) return [];
  const blockData = data[block];
  if (!isObject(blockData)) return [];
  const raw = blockData[field];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  if (isObject(raw) && Array.isArray(raw.value)) {
    return raw.value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

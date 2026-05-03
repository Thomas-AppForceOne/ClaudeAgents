/**
 * `additionalContext.path_resolves` invariant (F3 catalog; sourced from
 * U3).
 *
 * Each path listed in `planner.additionalContext` /
 * `proposer.additionalContext` (overlay splice points) must resolve to a
 * file that exists inside the project root.
 *
 * F3 catalogues this rule at warning level — a missing file may be a
 * legitimate "early-authoring" state. We surface it as an issue with
 * `severity: 'warning'` so callers can render it in lint output without
 * blocking dev workflows. Files that *escape* the project root are out
 * of scope here; that case is owned by `path.escape` and the two
 * invariants run independently (escape check is a hard error, this one
 * is a warning).
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

const PATH_BEARING_FIELDS: Array<{ block: 'proposer' | 'planner'; field: 'additionalContext' }> = [
  { block: 'proposer', field: 'additionalContext' },
  { block: 'planner', field: 'additionalContext' },
];

export function checkAdditionalContextPathResolves(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  const canonRoot = canonicalizePath(snapshot.projectRoot);
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    for (const target of PATH_BEARING_FIELDS) {
      const entries = extractPaths(row.data, target.block, target.field);
      for (const entry of entries) {
        // Skip path-escapers — they are reported by `path.escape`. The
        // two invariants are independent; reporting both for the same
        // entry would double-count without adding information.
        if (escapesRoot(entry, snapshot.projectRoot, canonRoot)) continue;
        const absolute = path.isAbsolute(entry) ? entry : path.resolve(snapshot.projectRoot, entry);
        if (entryExists(absolute)) continue;
        issues.push(buildIssue(row, target.block, target.field, entry));
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
    `Overlay '${row.path}' lists '${candidate}' under ${block}.${field}, but no file ` +
    `with that path exists in the project. Create the file at that path or remove ` +
    `the entry from the overlay.`;
  const err = createError('InvariantViolation', { message: messageBody });
  return {
    code: 'InvariantViolation',
    path: row.path,
    field: `/${block}/${field}`,
    message: err.message,
    severity: 'warning',
  };
}

function entryExists(absolute: string): boolean {
  if (!existsSync(absolute)) return false;
  try {
    const st = statSync(absolute);
    // Treat directories as non-existent for the purpose of this check —
    // `additionalContext` lists files, not directories.
    return st.isFile();
  } catch {
    return false;
  }
}

function escapesRoot(candidate: string, projectRoot: string, canonRoot: string): boolean {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  const canonCandidate = canonicalizePath(absolute);
  if (canonCandidate === canonRoot) return false;
  const sep = path.sep;
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

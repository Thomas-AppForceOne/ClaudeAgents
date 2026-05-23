

import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

const PATH_BEARING_FIELDS: Array<{
  block: 'planner' | 'proposer';
  field: 'additionalContext';
}> = [
  { block: 'planner', field: 'additionalContext' },
  { block: 'proposer', field: 'additionalContext' },
];

export function checkPathEscape(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  const canonicalRoot = canonicalizePath(snapshot.projectRoot);
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    for (const target of PATH_BEARING_FIELDS) {
      const entries = extractPaths(row.data, target.block, target.field);
      for (const entry of entries) {
        const issue = evaluateEntry(
          row,
          target.block,
          target.field,
          entry,
          canonicalRoot,
          snapshot,
        );
        if (issue) issues.push(issue);
      }
    }
  }
  return issues;
}

function evaluateEntry(
  row: SnapshotOverlayRow,
  block: 'planner' | 'proposer',
  field: 'additionalContext',
  entry: string,
  canonicalRoot: string,
  snapshot: ValidationSnapshot,
): Issue | null {
  const absolute = path.isAbsolute(entry) ? entry : path.resolve(snapshot.projectRoot, entry);

  let canonical: string;
  try {
    canonical = canonicalizePath(absolute);
  } catch {
    return null;
  }
  if (isDescendantOfRoot(canonical, canonicalRoot)) return null;
  return buildIssue(row, block, field, entry, canonical, canonicalRoot);
}

function isDescendantOfRoot(canonical: string, canonicalRoot: string): boolean {
  if (canonical === canonicalRoot) return true;
  const sep = path.sep;
  const altSep = sep === '/' ? '\\' : '/';
  if (canonical.startsWith(canonicalRoot + sep)) return true;
  if (canonical.startsWith(canonicalRoot + altSep)) return true;
  return false;
}

function buildIssue(
  row: SnapshotOverlayRow,
  block: 'planner' | 'proposer',
  field: 'additionalContext',
  entry: string,
  canonical: string,
  canonicalRoot: string,
): Issue {
  const messageBody =
    `Path "${entry}" resolves to "${canonical}" which is outside the project root "${canonicalRoot}". ` +
    `The framework only reads files that live underneath the project root. Edit '${row.path}' so the ` +
    `${block}.${field} entry points at a path inside the project, or remove the entry.`;
  const err = createError('PathEscape', {
    message: messageBody,
    path: entry,
    file: row.path,
    field: `/${block}/${field}`,
    remediation:
      `Edit '${row.path}' so the ${block}.${field} entry points at a path inside the project, ` +
      `or remove the entry.`,
  });
  return {
    code: 'PathEscape',
    severity: 'error',
    path: entry,
    field: `/${block}/${field}`,
    message: err.message,
  };
}

function extractPaths(
  data: unknown,
  block: 'planner' | 'proposer',
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

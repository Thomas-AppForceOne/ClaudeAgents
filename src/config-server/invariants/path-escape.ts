/**
 * Invariant `path.escape`: no overlay `additionalContext` entry may resolve to
 * a location outside the project root.
 *
 * This is a security boundary, not a typo check — the framework only ever reads
 * files beneath the project root, so a path that escapes (via an absolute path,
 * a `..` chain, or a symlink that points out of the tree) is rejected as an
 * `error` with the dedicated `PathEscape` code. Comparison is done on
 * canonicalised paths so symlink targets and `..` are fully resolved before the
 * containment test; an entry that cannot be canonicalised at all is treated as
 * benign here (returns no issue) and left to other checks.
 *
 * Counterpart to `additionalContext.path_resolves`: that invariant reports
 * missing in-tree files, this one reports out-of-tree paths. The two are
 * mutually exclusive per entry by construction (the resolves-check skips
 * escaping entries).
 */

import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

// The overlay locations that carry context file paths (planner/proposer
// `additionalContext`); a new path-bearing field is added here once.
const PATH_BEARING_FIELDS: Array<{
  block: 'planner' | 'proposer';
  field: 'additionalContext';
}> = [
  { block: 'planner', field: 'additionalContext' },
  { block: 'proposer', field: 'additionalContext' },
];

/**
 * Flag every additionalContext entry, across all overlay tiers, that resolves
 * outside the (canonicalised) project root.
 *
 * Canonicalises the project root once and reads only `snapshot.overlays`; no
 * disk writes, and it never throws on a normal outcome (per-entry
 * canonicalisation failures are caught in {@link evaluateEntry}).
 *
 * @param snapshot the validation snapshot; `projectRoot` and `overlays` are
 *   consulted.
 * @returns one `PathEscape` {@link Issue} per escaping entry; empty when every
 *   entry stays within the project.
 */
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

/**
 * Resolve and containment-check a single entry, returning the escape issue or
 * `null` when the entry is safe.
 *
 * A relative entry is resolved against the raw project root; the result is then
 * canonicalised so symlinks/`..` are followed before the containment test. A
 * canonicalisation failure (e.g. a path that cannot be realpath-ed) returns
 * `null` rather than throwing — this invariant only asserts "stays inside",
 * and an unresolvable path is not proven to escape.
 *
 * @param row the source overlay (for the reported location).
 * @param block / @param field which entry list this came from (for the
 *   pointer/message).
 * @param entry the raw path string from the overlay.
 * @param canonicalRoot the pre-canonicalised project root.
 * @param snapshot used only for the raw `projectRoot` when resolving a relative
 *   entry.
 * @returns a `PathEscape` issue, or `null` when the entry resolves inside the
 *   root or cannot be canonicalised.
 */
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

/**
 * True when `canonical` is the root itself or sits beneath it. Both paths are
 * already canonical. The `+ sep` boundary stops a sibling prefix (`/proj-x`)
 * from passing as a child of `/proj`, and the alternate separator is also
 * accepted so the judgment is OS-independent.
 */
function isDescendantOfRoot(canonical: string, canonicalRoot: string): boolean {
  if (canonical === canonicalRoot) return true;
  const sep = path.sep;
  const altSep = sep === '/' ? '\\' : '/';
  if (canonical.startsWith(canonicalRoot + sep)) return true;
  if (canonical.startsWith(canonicalRoot + altSep)) return true;
  return false;
}

/**
 * Build the `PathEscape` issue, including the resolved canonical target and the
 * project root in the message so the user sees exactly where the entry pointed.
 *
 * The inner `createError('PathEscape', …)` is used only to obtain the
 * framework-formatted message string; the returned {@link Issue} carries the
 * same `PathEscape` code, the raw `entry` as its `path`, and the `/block/field`
 * pointer.
 *
 * @param row the source overlay (reported location).
 * @param block / @param field the entry's location within the overlay.
 * @param entry the raw path string as written.
 * @param canonical the resolved canonical path that escaped.
 * @param canonicalRoot the project root it escaped from.
 */
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

/**
 * Pull the string paths out of `data[block][field]`, accepting both the plain
 * array form and the provenance-wrapped `{ value: [...] }` form, and dropping
 * non-string members. Returns `[]` for any missing or non-list shape.
 */
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

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

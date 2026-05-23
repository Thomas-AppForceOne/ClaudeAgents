/**
 * Invariant `additionalContext.path_resolves`: every file path listed under an
 * overlay's `proposer.additionalContext` / `planner.additionalContext` must
 * actually point at an existing regular file inside the project.
 *
 * This is the "the file you referenced is missing" check. Path *escapes*
 * (entries that resolve outside the project root) are handled by the separate
 * `path.escape` invariant and are deliberately skipped here, so the two
 * invariants do not both fire on the same entry: an escaping path is reported
 * once, as an escape, not also as a missing file.
 *
 * Issues are emitted at `warning` severity — a dangling additionalContext entry
 * is a likely mistake but does not make the config unsafe to run, so it informs
 * rather than blocks.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotOverlayRow, ValidationSnapshot } from '../tools/validate.js';

// The overlay locations that carry context file paths. Both the proposer and
// planner blocks expose an `additionalContext` list; this drives the check so a
// future path-bearing field is added in one place.
const PATH_BEARING_FIELDS: Array<{ block: 'proposer' | 'planner'; field: 'additionalContext' }> = [
  { block: 'proposer', field: 'additionalContext' },
  { block: 'planner', field: 'additionalContext' },
];

/**
 * Check that each additionalContext path across all overlay tiers resolves to
 * an existing file.
 *
 * Reads `snapshot.overlays` (already loaded by discovery) and stats candidate
 * paths on disk; no other side effects, and it never throws on a normal
 * outcome (stat failures are swallowed and treated as "not a file").
 *
 * @param snapshot the validation snapshot; only `projectRoot` and `overlays`
 *   are consulted.
 * @returns one `warning` {@link Issue} per dangling entry, or an empty list.
 *   Entries that escape the project root are skipped (owned by `path.escape`);
 *   relative entries are resolved against the raw (non-canonical) project root.
 */
export function checkAdditionalContextPathResolves(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  const canonRoot = canonicalizePath(snapshot.projectRoot);
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    for (const target of PATH_BEARING_FIELDS) {
      const entries = extractPaths(row.data, target.block, target.field);
      for (const entry of entries) {
        // Escaping paths belong to the `path.escape` invariant; skipping them
        // here keeps a single entry from generating two issues.
        if (escapesRoot(entry, snapshot.projectRoot, canonRoot)) continue;
        const absolute = path.isAbsolute(entry) ? entry : path.resolve(snapshot.projectRoot, entry);
        if (entryExists(absolute)) continue;
        issues.push(buildIssue(row, target.block, target.field, entry));
      }
    }
  }
  return issues;
}

/**
 * Build the warning issue for a single missing additionalContext path.
 *
 * @param row the overlay the entry came from; its `path` is reported as the
 *   issue location so the user knows which file to edit.
 * @param block the owning block name (`proposer`/`planner`), used in the
 *   message and the `/block/field` pointer.
 * @param field the field name (`additionalContext`).
 * @param candidate the raw path string as written in the overlay (not the
 *   resolved absolute form), so the message echoes what the user typed.
 * @returns an `InvariantViolation`-coded issue at `warning` severity.
 */
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

/**
 * True only when `absolute` names an existing *regular file*. A directory, a
 * dangling symlink, or any path that cannot be `stat`ed counts as "does not
 * exist" — the additionalContext entry is meant to be a file, so a directory at
 * that path is still a violation. The try/catch makes a stat failure (e.g. a
 * permission error or a symlink loop) a soft `false` rather than a throw.
 *
 * @param absolute an already-resolved absolute path.
 */
function entryExists(absolute: string): boolean {
  if (!existsSync(absolute)) return false;
  try {
    const st = statSync(absolute);

    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * True when `candidate` resolves to a location outside the project root — the
 * signal to defer to the `path.escape` invariant and skip this entry.
 *
 * Both the candidate and the root are canonicalised before comparison so
 * symlinks and `..` segments are followed; a path counts as inside the root
 * only if it equals the root or sits under it with a path separator boundary
 * (the `+ sep` guard prevents a sibling like `/proj-evil` from matching
 * `/proj`). Both `path.sep` and the opposite separator are accepted so a config
 * authored on one OS is judged the same on another.
 *
 * @param candidate the raw path string from the overlay.
 * @param projectRoot the raw project root, used to resolve a relative candidate.
 * @param canonRoot the pre-canonicalised project root to compare against.
 */
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

/**
 * Pull the list of string paths out of `data[block][field]`, tolerating the
 * two shapes a parsed overlay value can take.
 *
 * The field may appear either as a plain array, or — when the overlay layer has
 * wrapped it with provenance — as `{ value: [...] }`; both are unwrapped here.
 * Non-string members are dropped so a malformed entry never reaches the
 * existence check as a non-string.
 *
 * @param data the overlay body (unknown shape; non-objects yield `[]`).
 * @param block which block to read.
 * @param field which field within the block to read.
 * @returns the contained string paths, or `[]` when the path is absent or not
 *   a list.
 */
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

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

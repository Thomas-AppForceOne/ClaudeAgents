/**
 * Invariant `cacheEnv.no_conflict`: when two stack files both declare a
 * `cacheEnv` entry for the same environment variable, they must agree on its
 * `valueTemplate`.
 *
 * `cacheEnv` entries are merged across all active stacks into one environment,
 * so two stacks defining the same key with different templates is ambiguous —
 * there is no principled winner — and is reported as an `error` (it blocks).
 * Same key + identical template is fine (redundant but consistent).
 *
 * Determinism matters here: the "first" stack to declare a key becomes the
 * baseline that later stacks are compared against, so stacks are walked in a
 * stable, locale-sorted order ({@link orderedStackRows}). A `dedupeKey` guards
 * against emitting the same conflict twice when a key appears more than once
 * within a single later file.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/** A single observed `cacheEnv` declaration, remembered so a later, conflicting
 * declaration of the same key can name both sides in its message. */
interface Declaration {

  filePath: string;

  valueTemplate: string;
}

/**
 * Detect cross-stack `cacheEnv` value-template conflicts.
 *
 * Reads only `snapshot.stackFiles`; pure and never throws on a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns one `error` {@link Issue} per distinct (key, fileA, fileB) conflict,
 *   attributed to the *second* (later-sorted) file's path; empty when every
 *   shared key agrees. Entries missing `envVar`/`valueTemplate` strings, and
 *   stacks whose `cacheEnv` is not an array, are silently ignored (schema
 *   validation owns those shape complaints).
 */
export function checkCacheEnvNoConflict(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  // First-writer-wins record of each env var's baseline declaration.
  const seen: Map<string, Declaration> = new Map();

  // Conflicts already reported, keyed by (var, priorFile, currentFile), so a
  // key repeated within one file does not produce duplicate issues.
  const flagged: Set<string> = new Set();

  for (const row of orderedStackRows(snapshot)) {
    if (!row.data || !isObject(row.data)) continue;
    const cacheEnv = row.data['cacheEnv'];
    if (!Array.isArray(cacheEnv)) continue;
    for (const entry of cacheEnv) {
      if (!isObject(entry)) continue;
      const envVar = entry['envVar'];
      const valueTemplate = entry['valueTemplate'];
      if (typeof envVar !== 'string' || typeof valueTemplate !== 'string') continue;
      const prior = seen.get(envVar);
      if (!prior) {
        // First sighting of this key becomes the baseline; nothing to compare.
        seen.set(envVar, { filePath: row.path, valueTemplate });
        continue;
      }
      // Same key, same template across files is consistent — not a conflict.
      if (prior.valueTemplate === valueTemplate) continue;
      const dedupeKey = `${envVar}::${prior.filePath}::${row.path}`;
      if (flagged.has(dedupeKey)) continue;
      flagged.add(dedupeKey);
      const messageBody = buildConflictMessage(envVar, prior, {
        filePath: row.path,
        valueTemplate,
      });

      const err = createError('InvariantViolation', { message: messageBody });
      issues.push({
        code: 'InvariantViolation',
        path: row.path,
        field: '/cacheEnv',
        message: err.message,
        severity: 'error',
      });
    }
  }

  return issues;
}

/**
 * Compose the human-facing conflict message naming both stacks, the disputed
 * env var, and each side's template, plus how to fix it.
 *
 * @param envVar the shared environment-variable name.
 * @param prior the baseline declaration (first file, by sort order).
 * @param current the conflicting declaration (later file).
 */
function buildConflictMessage(envVar: string, prior: Declaration, current: Declaration): string {
  return (
    `Stack files '${prior.filePath}' and '${current.filePath}' both declare cacheEnv ` +
    `for '${envVar}' but with different valueTemplate values ` +
    `(${JSON.stringify(prior.valueTemplate)} vs. ${JSON.stringify(current.valueTemplate)}). ` +
    `Two active stacks must agree on the value template for any shared cacheEnv key. ` +
    `Edit one of the stack files so both rows declare the same valueTemplate, ` +
    `or remove the entry from one of them.`
  );
}

/**
 * Return the snapshot's stack rows in a deterministic order, sorted by their
 * map key (tier-prefixed path). The stable order is what makes the
 * "first-writer-wins baseline" above reproducible across runs and machines: a
 * raw `Map` iteration order would be insertion-dependent.
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

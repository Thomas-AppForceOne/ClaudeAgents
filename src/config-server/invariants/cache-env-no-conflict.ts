/**
 * `cacheEnv.no_conflict` invariant (F3 catalog; sourced from C1).
 *
 * Across active stack files, no two stacks may declare `cacheEnv` entries
 * with the same `envVar` and *different* `valueTemplate` values. Two
 * stacks declaring the same env var with the *same* template is fine
 * (idempotent). C1 catalogues the rule; F3 enumerates it; this module
 * implements it.
 *
 * Active set semantics (S4 placeholder): until C2 detection / dispatch
 * code lands in R1, "active" is approximated by "every discovered stack
 * file at any tier" — that is, every row in `snapshot.stackFiles`. This
 * is conservative (it may flag conflicts among stacks the project never
 * activates in practice), but the alternative — silently letting a
 * conflict ship — would defeat the invariant. Once C2's active-set
 * computation lands inside the snapshot, this module narrows to that set
 * without changing its public shape.
 */

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

interface Declaration {
  /** Stack file the declaration came from. */
  filePath: string;
  /** Resolved value template from the YAML body. */
  valueTemplate: string;
}

export function checkCacheEnvNoConflict(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];
  // envVar -> first-seen declaration (used to compare against later rows).
  const seen: Map<string, Declaration> = new Map();
  // envVar -> set of (filePath|template) tuples we've already flagged so a
  // three-way conflict produces exactly one issue per offending file pair.
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
        seen.set(envVar, { filePath: row.path, valueTemplate });
        continue;
      }
      if (prior.valueTemplate === valueTemplate) continue;
      const dedupeKey = `${envVar}::${prior.filePath}::${row.path}`;
      if (flagged.has(dedupeKey)) continue;
      flagged.add(dedupeKey);
      const messageBody = buildConflictMessage(envVar, prior, {
        filePath: row.path,
        valueTemplate,
      });
      // Build the error via the central factory so the wording stays
      // alongside other CacheEnvConflict messaging if it ever gains a
      // dedicated factory branch. We use `InvariantViolation` for the
      // F2 issue code (per S4 contract — no new codes introduced).
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
 * Iterate snapshot stack rows in deterministic order: the snapshot map is
 * keyed by `<tier>:<path>` and was inserted in `localeSort` order during
 * phase 1, but JavaScript Map iteration is insertion-order-based, which
 * means a re-arrangement in phase 1 would silently shift our output. We
 * sort the keys defensively here.
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

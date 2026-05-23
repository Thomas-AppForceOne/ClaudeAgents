

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

interface Declaration {

  filePath: string;

  valueTemplate: string;
}

export function checkCacheEnvNoConflict(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  const seen: Map<string, Declaration> = new Map();

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

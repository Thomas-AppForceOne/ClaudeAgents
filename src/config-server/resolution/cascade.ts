

import { localeSort } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';

export type SpliceRule =
  | 'list-union-by-string'
  | 'list-union-by-key-name'
  | 'list-union-by-key-command'
  | 'scalar-override'
  | 'deep-merge-cache-env';

export interface SpliceEntry {

  block: string;

  field: string;

  rule: SpliceRule;

  bareDefault: () => unknown;
}

export const SPLICE_POINTS: readonly SpliceEntry[] = [
  {
    block: 'stack',
    field: 'override',
    rule: 'list-union-by-string',
    bareDefault: () => [],
  },
  {
    block: 'stack',
    field: 'cacheEnvOverride',
    rule: 'deep-merge-cache-env',
    bareDefault: () => ({}),
  },
  {
    block: 'proposer',
    field: 'additionalCriteria',
    rule: 'list-union-by-key-name',
    bareDefault: () => [],
  },
  {
    block: 'proposer',
    field: 'suppressSurfaces',
    rule: 'list-union-by-string',
    bareDefault: () => [],
  },
  {
    block: 'proposer',
    field: 'additionalContext',
    rule: 'list-union-by-string',
    bareDefault: () => [],
  },
  {
    block: 'planner',
    field: 'additionalContext',
    rule: 'list-union-by-string',
    bareDefault: () => [],
  },
  {
    block: 'generator',
    field: 'additionalRules',
    rule: 'list-union-by-string',
    bareDefault: () => [],
  },
  {
    block: 'evaluator',
    field: 'additionalChecks',
    rule: 'list-union-by-key-command',
    bareDefault: () => [],
  },
  {
    block: 'runner',
    field: 'thresholdOverride',
    rule: 'scalar-override',
    bareDefault: () => undefined,
  },
];

export interface CascadeTiers {
  default: unknown | null;
  user: unknown | null;
  project: unknown | null;
}

export interface CascadeResult {

  merged: Record<string, unknown>;

  discarded: string[];

  issues: Issue[];
}

export function cascadeOverlays(tiers: CascadeTiers): CascadeResult {
  const issues: Issue[] = [];
  const discarded: string[] = [];
  const merged: Record<string, unknown> = {};

  for (const tierName of ['default', 'user', 'project'] as const) {
    const data = tiers[tierName];
    if (data === null || data === undefined) continue;
    if (!isObject(data)) {
      issues.push({
        code: 'MalformedInput',
        message: `Overlay tier '${tierName}' body must be a YAML mapping (object).`,
        severity: 'error',
      });
      continue;
    }
    validateUnknownWrappers(data, tierName, issues);
  }
  if (issues.length > 0) {
    return { merged, discarded, issues };
  }

  for (const entry of SPLICE_POINTS) {
    const { value, discarded: didDiscard } = resolveSplicePoint(entry, tiers);
    if (didDiscard) discarded.push(`${entry.block}.${entry.field}`);
    if (value === undefined) continue;
    if (!isObject(merged[entry.block])) {
      merged[entry.block] = {};
    }
    (merged[entry.block] as Record<string, unknown>)[entry.field] = value;
  }

  for (const block of Object.keys(merged)) {
    const v = merged[block];
    if (isObject(v) && Object.keys(v).length === 0) delete merged[block];
  }

  return { merged, discarded: localeSort(discarded), issues };
}

interface ResolvedField {

  value: unknown;

  discarded: boolean;
}

function resolveSplicePoint(entry: SpliceEntry, tiers: CascadeTiers): ResolvedField {

  const contributions = (['default', 'user', 'project'] as const).map((t) => {
    const blockData = readBlock(tiers[t], entry.block);
    return {
      tier: t,
      blockDiscardInherited: blockData ? blockData['discardInherited'] === true : false,
      raw: blockData ? blockData[entry.field] : undefined,
      blockPresent: blockData !== null,
    };
  });

  let acc: unknown = entry.bareDefault();
  let everDiscarded = false;
  let accDefined = false;

  for (const c of contributions) {

    const fieldLevel = parseFieldLevel(c.raw);

    const dropUpstream =
      fieldLevel.kind === 'wrapped' ? fieldLevel.discardInherited : c.blockDiscardInherited;
    if (dropUpstream) {
      everDiscarded = true;
      acc = entry.bareDefault();
      accDefined = false;
    }

    const bare = fieldLevel.kind === 'wrapped' ? fieldLevel.value : fieldLevel.bare;
    if (bare === undefined) continue;

    acc = applyMerge(entry.rule, acc, bare);
    accDefined = true;
  }

  if (!accDefined && !everDiscarded) {
    return { value: undefined, discarded: false };
  }

  return { value: acc, discarded: everDiscarded };
}

type FieldLevelForm =
  | { kind: 'bare'; bare: unknown }
  | { kind: 'wrapped'; discardInherited: boolean; value: unknown };

function parseFieldLevel(raw: unknown): FieldLevelForm {
  if (raw === undefined) return { kind: 'bare', bare: undefined };
  if (isObject(raw) && typeof raw['discardInherited'] === 'boolean' && isWrapperShape(raw)) {
    return {
      kind: 'wrapped',
      discardInherited: raw['discardInherited'] === true,
      value: 'value' in raw ? raw['value'] : undefined,
    };
  }
  return { kind: 'bare', bare: raw };
}

function isWrapperShape(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) {
    if (k !== 'discardInherited' && k !== 'value') return false;
  }
  return true;
}

function validateUnknownWrappers(
  data: Record<string, unknown>,
  tierName: string,
  issues: Issue[],
): void {
  for (const entry of SPLICE_POINTS) {
    const block = data[entry.block];
    if (!isObject(block)) continue;
    const raw = block[entry.field];
    if (!isObject(raw)) continue;

    if ('discardInherited' in raw) {
      for (const k of Object.keys(raw)) {
        if (k !== 'discardInherited' && k !== 'value') {
          issues.push({
            code: 'MalformedInput',
            field: `/${entry.block}/${entry.field}`,
            message:
              `Overlay tier '${tierName}' field '${entry.block}.${entry.field}' uses a ` +
              `structured wrapper with an unknown property '${k}'. The framework only ` +
              `accepts '{discardInherited, value?}'. Remove the unknown property or ` +
              `replace the wrapper with a bare value.`,
            severity: 'error',
          });
          break;
        }
      }
    }
  }
}

function readBlock(tierData: unknown, block: string): Record<string, unknown> | null {
  if (!isObject(tierData)) return null;
  const v = tierData[block];
  if (!isObject(v)) return null;
  return v;
}

function applyMerge(rule: SpliceRule, lower: unknown, higher: unknown): unknown {
  switch (rule) {
    case 'scalar-override':
      return higher;
    case 'list-union-by-string':
      return mergeStringList(lower, higher);
    case 'list-union-by-key-name':
      return mergeKeyedList(lower, higher, 'name');
    case 'list-union-by-key-command':
      return mergeKeyedList(lower, higher, 'command');
    case 'deep-merge-cache-env':
      return deepMergeCacheEnv(lower, higher);
  }
}

function mergeStringList(lower: unknown, higher: unknown): unknown {
  const lo = Array.isArray(lower) ? lower.filter((v): v is string => typeof v === 'string') : [];
  const hi = Array.isArray(higher) ? higher.filter((v): v is string => typeof v === 'string') : [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const s of lo) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  for (const s of hi) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function mergeKeyedList(lower: unknown, higher: unknown, keyField: string): unknown {
  const lo = Array.isArray(lower) ? (lower as unknown[]).filter(isObject) : [];
  const hi = Array.isArray(higher) ? (higher as unknown[]).filter(isObject) : [];
  const higherByKey = new Map<string, Record<string, unknown>>();
  const newEntries: Array<Record<string, unknown>> = [];
  const lowerKeys = new Set<string>();
  for (const o of lo) {
    const k = o[keyField];
    if (typeof k === 'string') lowerKeys.add(k);
  }
  for (const o of hi) {
    const k = o[keyField];
    if (typeof k !== 'string') {
      newEntries.push(o);
      continue;
    }
    if (lowerKeys.has(k)) {
      higherByKey.set(k, o);
    } else if (!higherByKey.has(k)) {
      higherByKey.set(k, o);
      newEntries.push(o);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const o of lo) {
    const k = o[keyField];
    if (typeof k === 'string' && higherByKey.has(k) && lowerKeys.has(k)) {
      out.push(higherByKey.get(k) as Record<string, unknown>);
    } else {
      out.push(o);
    }
  }

  for (const o of newEntries) out.push(o);
  return out;
}

function deepMergeCacheEnv(lower: unknown, higher: unknown): unknown {
  const lo = isObject(lower) ? lower : {};
  const hi = isObject(higher) ? higher : {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(lo)) out[k] = lo[k];
  for (const k of Object.keys(hi)) {
    const lv = out[k];
    const hv = hi[k];
    if (isObject(lv) && isObject(hv)) {
      const merged: Record<string, unknown> = {};
      for (const ik of Object.keys(lv)) merged[ik] = lv[ik];
      for (const ik of Object.keys(hv)) merged[ik] = hv[ik];
      out[k] = merged;
    } else {
      out[k] = hv;
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export { isObject as _cascadeIsObject };

export function unknownWrapperError(field: string, key: string): Error {
  return createError('MalformedInput', {
    field,
    message:
      `Overlay field '${field}' uses a structured wrapper with an unknown property '${key}'. ` +
      `The framework only accepts '{discardInherited, value?}'. Remove the unknown property or ` +
      `replace the wrapper with a bare value.`,
  });
}

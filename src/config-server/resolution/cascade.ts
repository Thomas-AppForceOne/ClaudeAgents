/**
 * R1 sprint 5 — C4 three-tier overlay cascade.
 *
 * Resolves a single merged overlay view from up to three tier inputs
 * (`default` < `user` < `project`, with project being the leaf and
 * authoritative on conflict). The cascade mechanics live here; the
 * per-splice-point merge rule is read from C3's catalog (encoded in the
 * `SPLICE_POINTS` table below). New splice points land by editing the
 * table and (optionally) the unit tests; new merge *rules* land by
 * extending `SpliceRule` and the dispatcher.
 *
 * Two-form `discardInherited` per C3:
 *  - **Block-level** — `<block>.discardInherited: true`. Drops every
 *    upstream value within that block before merging the higher tier.
 *  - **Field-level** — `<field>: { discardInherited: true, value?: X }`.
 *    Drops just that field's upstream contribution; the optional `value`
 *    provides a replacement, or the field falls back to the catalog
 *    default if `value` is absent.
 *
 * Field-level wins over block-level (more-specific wins). An unknown
 * structured wrapper (e.g. `{ unknown: ... }` on a field that does not
 * accept the structured form) is rejected as `MalformedInput`.
 *
 * Returns `{ merged, discarded, issues }`. `discarded` is a list of
 * `<block>.<field>` paths whose upstream contribution was dropped — used
 * by `composeResolvedConfig` to populate F2's `discarded` surface so O1
 * can show users which tiers their config silenced.
 */

import { localeSort } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';

/** A splice-point merge rule, read from C3's catalog. */
export type SpliceRule =
  | 'list-union-by-string'
  | 'list-union-by-key-name'
  | 'list-union-by-key-command'
  | 'scalar-override'
  | 'deep-merge-cache-env';

/** A single splice-point catalog entry. */
export interface SpliceEntry {
  /** Block name (top-level key under the overlay root). */
  block: string;
  /** Field name (key under the block). */
  field: string;
  /** Merge rule per C3's catalog. */
  rule: SpliceRule;
  /** Bare default emitted when `discardInherited: true` has no replacement. */
  bareDefault: () => unknown;
}

/**
 * C3 splice-point catalog (data, not code). Keep this list in sync with
 * the table in `specifications/C3-overlay-schema.md` ("Splice-point
 * catalog (authoritative)"). Order is the table's order so debug dumps
 * read top-to-bottom like the spec.
 */
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

/** Tier inputs to the cascade. `null` means the tier is absent. */
export interface CascadeTiers {
  default: unknown | null;
  user: unknown | null;
  project: unknown | null;
}

/** Result of a cascade. */
export interface CascadeResult {
  /** Merged overlay object. Keys sorted at every depth by stableStringify. */
  merged: Record<string, unknown>;
  /** Per-splice-point discard summary (`<block>.<field>` strings). */
  discarded: string[];
  /** Hard errors raised during cascade (unknown wrapper, etc.). */
  issues: Issue[];
}

/**
 * Run the three-tier cascade per C4.
 *
 * @param tiers per-tier overlay bodies (`default` is the bottom; `project`
 *   is the leaf and the authoritative tier on conflict). Pass `null` for
 *   absent tiers; this is the same shape `loadOverlay` returns for a
 *   missing file.
 */
export function cascadeOverlays(tiers: CascadeTiers): CascadeResult {
  const issues: Issue[] = [];
  const discarded: string[] = [];
  const merged: Record<string, unknown> = {};

  // Validate each tier first; reject unknown structured wrappers fast.
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

  // Cascade splice point by splice point. Each runs independently per C3.
  for (const entry of SPLICE_POINTS) {
    const { value, discarded: didDiscard } = resolveSplicePoint(entry, tiers);
    if (didDiscard) discarded.push(`${entry.block}.${entry.field}`);
    if (value === undefined) continue;
    if (!isObject(merged[entry.block])) {
      merged[entry.block] = {};
    }
    (merged[entry.block] as Record<string, unknown>)[entry.field] = value;
  }

  // Strip empty blocks so consumers don't see `proposer: {}` when nothing
  // landed in it. The cascade is conservative: a block whose only field
  // resolved to undefined (e.g. `runner.thresholdOverride` with no value
  // anywhere) should not appear at all.
  for (const block of Object.keys(merged)) {
    const v = merged[block];
    if (isObject(v) && Object.keys(v).length === 0) delete merged[block];
  }

  // Sort discarded for determinism.
  return { merged, discarded: localeSort(discarded), issues };
}

interface ResolvedField {
  /** The resolved value, or `undefined` to omit the field entirely. */
  value: unknown;
  /** Whether the resolution involved discarding upstream contribution. */
  discarded: boolean;
}

function resolveSplicePoint(entry: SpliceEntry, tiers: CascadeTiers): ResolvedField {
  // Build per-tier "contributions". Each contribution carries:
  //  - the raw value the tier supplied (may be a bare value or a structured
  //    `{discardInherited, value?}` wrapper);
  //  - whether the tier's *block-level* `discardInherited` is set.
  const contributions = (['default', 'user', 'project'] as const).map((t) => {
    const blockData = readBlock(tiers[t], entry.block);
    return {
      tier: t,
      blockDiscardInherited: blockData ? blockData['discardInherited'] === true : false,
      raw: blockData ? blockData[entry.field] : undefined,
      blockPresent: blockData !== null,
    };
  });

  // Walk default → user → project, merging into `acc` per the rule.
  let acc: unknown = entry.bareDefault();
  let everDiscarded = false;
  let accDefined = false; // whether `acc` represents a real merged value yet

  for (const c of contributions) {
    // Determine the field-level form the tier supplied for this field.
    const fieldLevel = parseFieldLevel(c.raw);
    // Field-level wins over block-level when both are set.
    const dropUpstream =
      fieldLevel.kind === 'wrapped' ? fieldLevel.discardInherited : c.blockDiscardInherited;
    if (dropUpstream) {
      everDiscarded = true;
      acc = entry.bareDefault();
      accDefined = false;
    }

    // Pull the bare value contributed by this tier (if any).
    const bare = fieldLevel.kind === 'wrapped' ? fieldLevel.value : fieldLevel.bare;
    if (bare === undefined) continue;

    acc = applyMerge(entry.rule, acc, bare);
    accDefined = true;
  }

  // For scalar-override, an undefined acc with no contribution stays undefined
  // (no bare default to emit). For collection rules, the bare default ([],
  // {}) is a valid resolved value when at least one tier discarded — so we
  // emit it. When no tier supplied anything *and* no discard happened,
  // collection rules also stay undefined so the field is omitted from the
  // merged view.
  if (!accDefined && !everDiscarded) {
    return { value: undefined, discarded: false };
  }

  return { value: acc, discarded: everDiscarded };
}

type FieldLevelForm =
  | { kind: 'bare'; bare: unknown }
  | { kind: 'wrapped'; discardInherited: boolean; value: unknown };

/**
 * Parse the per-tier raw value as either a bare value or a structured
 * `{discardInherited, value?}` wrapper. The wrapper detection mirrors
 * C3's schema: an object with a boolean `discardInherited` property, plus
 * an optional `value`. Anything else is treated as bare. Validation of
 * "unknown wrapper" shapes happens up front in `validateUnknownWrappers`.
 */
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

/**
 * A field-level wrapper is exactly `{ discardInherited: boolean, value?: ... }`.
 * Anything else with extra keys is not a wrapper — it's a bare object the
 * field happens to take (e.g. a `cacheEnvOverride` map). The schema's oneOf
 * branches enforce this, but at runtime we double-check.
 */
function isWrapperShape(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) {
    if (k !== 'discardInherited' && k !== 'value') return false;
  }
  return true;
}

/**
 * Pre-validate wrappers across every block/field so we can fail closed
 * before merging. Specifically, a `{discardInherited, value?, ...extras}`
 * shape on any splice-point field is a `MalformedInput`. We do not check
 * for unknown blocks/fields here — that is the schema validator's job
 * (S3) and should not be repeated.
 */
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
    // Heuristic: if the field's raw value is an object AND it has
    // `discardInherited` AND it has any *other* keys outside
    // `{discardInherited, value}`, it's malformed.
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

// ---- merge dispatcher ----------------------------------------------------

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
  // Lower-tier-first ordering, dedup by exact string.
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

/**
 * Merge two object lists keyed by `keyField`. Implements C4's
 * duplicate-key positioning rule:
 *
 *   lower [A, B, C] + higher [X, B', Y]  ->  [A, B', C, X, Y]
 *
 * - B' is matched to B by the key field; B' replaces B *in B's slot*.
 * - X and Y are new entries from the higher tier; they append after the
 *   resolved lower-tier list, in the higher tier's source order.
 */
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
  // Append new entries (higher-tier keys not present in lower) in higher's
  // source order. We already pushed them into `newEntries` above.
  for (const o of newEntries) out.push(o);
  return out;
}

/**
 * Deep merge for `stack.cacheEnvOverride`: a map of `<stack> -> <envVar> ->
 * <valueTemplate>`. Project keys win on duplicate at any depth; otherwise
 * additive.
 */
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

// Exported for tests and resolved-config consumers.
export { isObject as _cascadeIsObject };

/** Build a typed error for an unknown wrapper, in case callers want to throw. */
export function unknownWrapperError(field: string, key: string): Error {
  return createError('MalformedInput', {
    field,
    message:
      `Overlay field '${field}' uses a structured wrapper with an unknown property '${key}'. ` +
      `The framework only accepts '{discardInherited, value?}'. Remove the unknown property or ` +
      `replace the wrapper with a bare value.`,
  });
}

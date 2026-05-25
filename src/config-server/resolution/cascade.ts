/**
 * The overlay cascade: merge the three overlay tiers (default → user →
 * project) into one effective config, field by field.
 *
 * Only a fixed allowlist of fields — the *splice points* in
 * {@link SPLICE_POINTS} — participate; everything else in an overlay is
 * ignored by the cascade. Each splice point declares its own merge rule (union
 * a string list, union a keyed list, scalar-override, deep-merge), so the
 * cascade has no per-field special-casing: it just looks up the rule.
 *
 * Tier order is fixed lowest-to-highest as default, user, project — a higher
 * tier's contribution wins/extends a lower tier's per the field's rule. A tier
 * (or a single field) may also set `discardInherited` to drop everything
 * contributed by lower tiers before its own value applies; that reset is
 * recorded in {@link CascadeResult.discarded} so callers can show the user
 * which fields were truncated.
 */

import { localeSort } from '../determinism/index.js';
import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';

/**
 * How a splice point's contributions from successive tiers are combined:
 * - `list-union-by-string` — concatenate string lists, de-duplicating by value.
 * - `list-union-by-key-name` — union object lists, keyed by each item's `name`.
 * - `list-union-by-key-command` — union object lists, keyed by `command`.
 * - `scalar-override` — the highest tier's value simply replaces lower ones.
 * - `deep-merge-cache-env` — recursively merge the cacheEnv mapping (one level).
 * - `merge-role-map` — per-key merge of a flat role→integer map (one level): a
 *   higher tier overrides/extends a lower tier's per-role keys rather than
 *   replacing the whole map, so `safety.attemptCeilings` setting one role keeps
 *   the other roles' lower-tier (or seed) ceilings.
 */
export type SpliceRule =
  | 'list-union-by-string'
  | 'list-union-by-key-name'
  | 'list-union-by-key-command'
  | 'scalar-override'
  | 'deep-merge-cache-env'
  | 'merge-role-map';

/**
 * Declaration of one mergeable field.
 *
 * @property block the top-level overlay block the field lives under (e.g.
 *   `stack`, `proposer`).
 * @property field the field name within that block.
 * @property rule the {@link SpliceRule} used to combine tier contributions.
 * @property bareDefault factory for the starting accumulator when no tier has
 *   contributed yet (and the value used after a `discardInherited` reset). It
 *   is a *factory*, not a constant, so each resolution gets a fresh mutable
 *   value (`[]`/`{}`) and cannot leak state between projects.
 */
export interface SpliceEntry {

  block: string;

  field: string;

  rule: SpliceRule;

  bareDefault: () => unknown;
}

/**
 * The complete, ordered allowlist of mergeable overlay fields. A field absent
 * from this table is not part of the effective config — adding a new
 * overlay-driven setting means adding an entry here (plus its schema).
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
  // safety.* splice points. attemptCeilings is a per-role map merged
  // key-by-key (merge-role-map), so a higher tier setting one role's ceiling
  // does not wipe the others; sprintBudget and oscillationDetection are plain
  // scalars where the highest tier wins. Each bareDefault is a fresh factory:
  // the map starts as a new {} per resolution (no shared mutable state), and
  // the two scalars start undefined so an absent field is omitted from the
  // merged overlay entirely (the resolver then applies the seed default).
  {
    block: 'safety',
    field: 'attemptCeilings',
    rule: 'merge-role-map',
    bareDefault: () => ({}),
  },
  {
    block: 'safety',
    field: 'sprintBudget',
    rule: 'scalar-override',
    bareDefault: () => undefined,
  },
  {
    block: 'safety',
    field: 'oscillationDetection',
    rule: 'scalar-override',
    bareDefault: () => undefined,
  },
  // clarifier.draftTimeoutSeconds is a plain scalar where the highest tier wins.
  // bareDefault is undefined so an absent value is omitted from the merged
  // overlay entirely (rather than seeded), letting the resolver fall back to the
  // framework's seed default of 60. The [10, 600] bound is NOT enforced here:
  // the cascade only merges, and an out-of-range value is caught by the semantic
  // range check during validation, so a 0 surfaces as InvalidTimeoutValue rather
  // than being silently passed through or coerced.
  {
    block: 'clarifier',
    field: 'draftTimeoutSeconds',
    rule: 'scalar-override',
    bareDefault: () => undefined,
  },
];

/**
 * The three overlay tiers' parsed bodies, in precedence-naming (not array)
 * form. Each is the raw parsed YAML body or `null`/`undefined` when that tier's
 * file is absent or empty. A present-but-non-object body is reported as an
 * issue rather than silently dropped.
 */
export interface CascadeTiers {
  default: unknown | null;
  user: unknown | null;
  project: unknown | null;
}

/**
 * The result of cascading the tiers.
 *
 * @property merged the effective config: `block → field → mergedValue`. Only
 *   splice-point fields appear, and blocks left empty after merging are
 *   pruned.
 * @property discarded dotted `block.field` names where some tier set
 *   `discardInherited`, truncating lower-tier contributions; locale-sorted for
 *   determinism.
 * @property issues malformed-input findings (non-object tier body, or an
 *   unknown property inside a structured wrapper). When non-empty, `merged` is
 *   returned empty — a malformed overlay aborts the merge rather than producing
 *   a half-merged config.
 */
export interface CascadeResult {

  merged: Record<string, unknown>;

  discarded: string[];

  issues: Issue[];
}

/**
 * Cascade the three overlay tiers into the effective config.
 *
 * @param tiers the parsed bodies; see {@link CascadeTiers}.
 * @returns a {@link CascadeResult}. Never throws — input problems surface as
 *   `issues`.
 *
 * Two-pass structure: first every tier body is shape-validated (must be an
 * object; structured wrappers must not carry unknown keys) and, if *any* issue
 * is found, the merge is abandoned and an empty `merged` is returned so a
 * malformed file never yields partial config. Otherwise each splice point is
 * resolved across the tiers in order, empty blocks are pruned, and `discarded`
 * is sorted for stable output.
 */
export function cascadeOverlays(tiers: CascadeTiers): CascadeResult {
  const issues: Issue[] = [];
  const discarded: string[] = [];
  const merged: Record<string, unknown> = {};

  // Pass 1 — validate every tier's shape up front. Accumulating all issues
  // before merging means the user sees every malformed tier at once, not one
  // per re-run.
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
  // Abort on any shape problem: a partial merge of a malformed overlay would be
  // misleading, so return empty `merged` and let the caller surface `issues`.
  if (issues.length > 0) {
    return { merged, discarded, issues };
  }

  // Pass 2 — resolve each allowlisted field across the tiers.
  for (const entry of SPLICE_POINTS) {
    const { value, discarded: didDiscard } = resolveSplicePoint(entry, tiers);
    if (didDiscard) discarded.push(`${entry.block}.${entry.field}`);
    // `undefined` means no tier contributed and nothing was discarded — leave
    // the field out of the effective config entirely.
    if (value === undefined) continue;
    if (!isObject(merged[entry.block])) {
      merged[entry.block] = {};
    }
    (merged[entry.block] as Record<string, unknown>)[entry.field] = value;
  }

  // Prune blocks that ended up empty (e.g. their only field resolved to
  // `undefined`), so the merged shape carries no hollow `{}` placeholders.
  for (const block of Object.keys(merged)) {
    const v = merged[block];
    if (isObject(v) && Object.keys(v).length === 0) delete merged[block];
  }

  return { merged, discarded: localeSort(discarded), issues };
}

/**
 * Outcome of resolving a single splice point.
 *
 * @property value the merged value, or `undefined` when no tier contributed
 *   and no reset occurred (the caller then omits the field).
 * @property discarded `true` if any tier reset the accumulation via
 *   `discardInherited` (recorded for user-facing reporting).
 */
interface ResolvedField {

  value: unknown;

  discarded: boolean;
}

// Resolve one splice point by folding the three tiers' contributions in order.
// The fold tracks two extra flags beyond the accumulator: whether anything was
// ever discarded (a reset happened) and whether anything was ever defined (a
// real contribution arrived) — together they distinguish "no value" from
// "explicitly reset to default", which the caller treats differently.
function resolveSplicePoint(entry: SpliceEntry, tiers: CascadeTiers): ResolvedField {

  // Snapshot each tier's contribution for this field, capturing both the raw
  // field value and the block-level `discardInherited` flag (which resets
  // every field of the block, not just one).
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
    // A field may be given bare, or wrapped as `{discardInherited, value?}` to
    // request a per-field reset; normalise both forms here.
    const fieldLevel = parseFieldLevel(c.raw);

    // A reset can come from the field's own wrapper or from the block-level
    // flag; either drops everything accumulated from lower tiers.
    const dropUpstream =
      fieldLevel.kind === 'wrapped' ? fieldLevel.discardInherited : c.blockDiscardInherited;
    if (dropUpstream) {
      everDiscarded = true;
      acc = entry.bareDefault();
      accDefined = false;
    }

    const bare = fieldLevel.kind === 'wrapped' ? fieldLevel.value : fieldLevel.bare;
    // A wrapper with no `value` (reset-only) contributes nothing to merge.
    if (bare === undefined) continue;

    acc = applyMerge(entry.rule, acc, bare);
    accDefined = true;
  }

  // No contribution and no reset ⇒ the field is genuinely absent. Return
  // `undefined` so the caller omits it (rather than emitting an empty default).
  if (!accDefined && !everDiscarded) {
    return { value: undefined, discarded: false };
  }

  // Either a value was contributed, or a reset happened (which deliberately
  // surfaces the bare default, e.g. an empty list, to truncate inheritance).
  return { value: acc, discarded: everDiscarded };
}

// The two forms a field value may take: a plain `bare` value, or a structured
// `{discardInherited, value?}` wrapper that requests a per-field reset.
type FieldLevelForm =
  | { kind: 'bare'; bare: unknown }
  | { kind: 'wrapped'; discardInherited: boolean; value: unknown };

// Classify a raw field value. Only an object that has a boolean
// `discardInherited` AND no keys other than `discardInherited`/`value` counts
// as a wrapper; anything else (including a plain config object that merely
// happens to contain other keys) is treated as a bare value, so user data is
// never mistaken for a control wrapper.
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

// True when an object has only the permitted wrapper keys (`discardInherited`
// and optionally `value`). Used to distinguish a real wrapper from arbitrary
// config that incidentally has a `discardInherited` key.
function isWrapperShape(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) {
    if (k !== 'discardInherited' && k !== 'value') return false;
  }
  return true;
}

// Flag wrappers that look intentional (they carry `discardInherited`) but
// include a stray, unknown property — a likely typo the user wants to know
// about rather than have silently treated as a bare value. Pushes one issue
// per offending field, naming the unknown key.
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

    // Only objects that opted into the wrapper form (have `discardInherited`)
    // are policed; a bare object value is none of this check's business.
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

// Extract `tierData[block]` as an object, or null when the tier or block is
// absent/non-object. Lets callers treat "tier missing", "block missing", and
// "block not an object" uniformly as "no contribution".
function readBlock(tierData: unknown, block: string): Record<string, unknown> | null {
  if (!isObject(tierData)) return null;
  const v = tierData[block];
  if (!isObject(v)) return null;
  return v;
}

// Dispatch a single merge step (lower-tier accumulator + higher-tier value) to
// the implementation for `rule`. `higher` always wins/extends `lower` per the
// rule's semantics. The switch is exhaustive over SpliceRule, so adding a rule
// is a compile error here until handled.
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
    case 'merge-role-map':
      return mergeRoleMap(lower, higher);
  }
}

// Role keys that must never index a role-keyed accumulator: they are the
// prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/trace/reconcile.ts` and `FORBIDDEN_ROLE_KEYS` in the safety modules, so
// the cascade's per-role merge cannot regress the guard those layers establish.
// A `__proto__`-named "role" in an overlay is hostile input, never a real role.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

// One-level per-key merge of two flat role→integer maps: higher-tier keys win,
// lower-tier keys survive when the higher tier does not mention them (so setting
// one role's ceiling never wipes the others). Built on a null-prototype
// accumulator with the forbidden-key skip and Object.defineProperty install — the
// same discipline the safety modules and trace-reconcile layer use — so a
// `__proto__`/`constructor`/`prototype` role name in an overlay cannot pollute
// Object.prototype, crash resolution, or shadow a genuine role's ceiling. Only
// integer values are kept; the schema already enforces positive integers, so a
// non-integer here is defensive degradation rather than an expected input.
function mergeRoleMap(lower: unknown, higher: unknown): unknown {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  const installFrom = (src: unknown): void => {
    if (!isObject(src)) return;
    for (const role of Object.keys(src)) {
      if (FORBIDDEN_ROLE_KEYS.has(role)) continue;
      const v = src[role];
      if (typeof v !== 'number' || !Number.isInteger(v)) continue;
      Object.defineProperty(out, role, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  };
  // Lower first, then higher, so a higher-tier key overwrites a lower-tier one
  // while untouched lower-tier keys remain.
  installFrom(lower);
  installFrom(higher);
  return out;
}

// Union two string lists preserving lower-then-higher order and dropping
// duplicates (first occurrence wins position). Non-string entries and
// non-array inputs are filtered out so a malformed value degrades to empty
// rather than corrupting the result.
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

// Union two lists of objects keyed by `keyField` (e.g. `name` or `command`).
// A higher-tier entry whose key matches a lower-tier one *replaces* it in
// place (so the lower entry's slot is preserved in order but its content is
// the higher one); higher-tier entries with new keys are appended after the
// lower list. Entries lacking a string key cannot collide, so they are kept as
// distinct new entries. The result preserves lower-tier ordering with
// overrides applied, then appends genuinely new higher-tier entries.
function mergeKeyedList(lower: unknown, higher: unknown, keyField: string): unknown {
  const lo = Array.isArray(lower) ? (lower as unknown[]).filter(isObject) : [];
  const hi = Array.isArray(higher) ? (higher as unknown[]).filter(isObject) : [];
  // higherByKey: overrides for keys that exist in the lower list.
  // newEntries: higher-tier entries to append (new keys, or keyless).
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
      // Keyless higher entry: cannot override anything, so always a new entry.
      newEntries.push(o);
      continue;
    }
    if (lowerKeys.has(k)) {
      // Matches a lower entry → record as an in-place override.
      higherByKey.set(k, o);
    } else if (!higherByKey.has(k)) {
      // New key (and not already seen among higher entries) → append once.
      higherByKey.set(k, o);
      newEntries.push(o);
    }
  }
  // Rebuild the lower list, swapping in any higher-tier override at its
  // original position so ordering stays stable across the merge.
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

// One-level deep merge of two cacheEnv mappings: higher-tier keys win, but when
// both tiers map a key to an object the two objects are themselves merged
// (higher wins per inner key) rather than the higher object wholesale replacing
// the lower. Non-object collisions take the higher value outright.
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

// Local plain-object guard: true only for a non-null, non-array object.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Test-only re-export (note the `_` prefix) so unit tests can exercise this
// module's exact object predicate without duplicating it.
export { isObject as _cascadeIsObject };

/**
 * Build (but do not throw) the `MalformedInput` error describing a structured
 * wrapper that carries an unknown property.
 *
 * @param field the dotted field name the wrapper appears under.
 * @param key the offending unknown property name.
 * @returns a {@link ConfigServerError}; the caller decides whether to throw it
 *   or fold it into an issue. (The in-cascade path reports via
 *   {@link validateUnknownWrappers}; this is the throwing-style counterpart for
 *   callers that need an `Error`.)
 */
export function unknownWrapperError(field: string, key: string): Error {
  return createError('MalformedInput', {
    field,
    message:
      `Overlay field '${field}' uses a structured wrapper with an unknown property '${key}'. ` +
      `The framework only accepts '{discardInherited, value?}'. Remove the unknown property or ` +
      `replace the wrapper with a bare value.`,
  });
}

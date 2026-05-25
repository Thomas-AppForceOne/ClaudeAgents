/**
 * Semantic range check for the `clarifier.draftTimeoutSeconds` overlay field.
 *
 * The JSON schema types this field as a bare integer with no min/max, so a
 * non-integer is caught there as a generic shape fault (`SchemaMismatch`). The
 * meaningful [10, 600] bound is a *semantic* constraint the schema deliberately
 * does not express: an integer-but-out-of-range value (including 0) is a
 * different class of fault that deserves its own structured code
 * (`InvalidTimeoutValue`) and remediation. Splitting the two keeps each layer
 * single-purpose and avoids double-reporting — this check ignores non-integers
 * precisely so the schema layer owns them.
 */

import { createError } from '../errors.js';
import { type Issue } from './schema-check.js';

// The inclusive bound the timeout must satisfy. A 0 (or any value below 10) is
// rejected rather than treated as "skip"; the bypass case has its own flag, so
// a zero here is far more likely an out-of-range mistake than an intent to skip.
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;

/**
 * Append an {@link Issue} when an overlay declares a `clarifier.draftTimeoutSeconds`
 * that is an integer outside the inclusive [10, 600] range.
 *
 * @param filePath absolute path of the overlay file, recorded in the issue's
 *   `path` so the user can locate the offending declaration.
 * @param data the parsed overlay body. A non-object body (e.g. an empty/`null`
 *   overlay) is ignored — there is nothing to range-check.
 * @param issues accumulator mutated in place; at most one issue is appended
 *   (code `InvalidTimeoutValue`, severity `error`) when the value is an
 *   out-of-range integer. An absent field, a wrapper carrying no `value`, or a
 *   non-integer value all leave the accumulator untouched: a non-integer is left
 *   to the schema layer so the two checks never both report the same field.
 *
 * Does not throw and returns nothing — faults are reported only by pushing into
 * `issues`. Both the bare form (`draftTimeoutSeconds: 30`) and the cascade
 * wrapper form (`draftTimeoutSeconds: { discardInherited, value: 30 }`) are
 * inspected; the wrapper's `.value` is the value range-checked.
 */
export function checkClarifierTimeoutRange(
  filePath: string,
  data: unknown,
  issues: Issue[],
): void {
  if (!isObject(data)) return;

  const clarifier = data['clarifier'];
  if (!isObject(clarifier)) return;

  const value = extractTimeoutValue(clarifier['draftTimeoutSeconds']);
  // Only an integer participates: a non-integer is a shape fault the schema
  // already reports as SchemaMismatch, and an absent value defaults downstream.
  if (typeof value !== 'number' || !Number.isInteger(value)) return;
  if (value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS) return;

  const error = createError('InvalidTimeoutValue', {
    message:
      `The overlay at '${filePath}' sets 'clarifier.draftTimeoutSeconds' to ${value}, ` +
      `which is out of range; it must be an integer between ${MIN_TIMEOUT_SECONDS} and ` +
      `${MAX_TIMEOUT_SECONDS} seconds. To bypass clarification entirely, use the dedicated ` +
      `skip flag rather than a zero timeout.`,
  });
  issues.push({
    code: error.code,
    path: filePath,
    field: '/clarifier/draftTimeoutSeconds',
    message: error.message,
    severity: 'error',
  });
}

// Pull the value to range-check out of either field form. A bare value is taken
// directly; the cascade wrapper (`{discardInherited, value?}`) contributes its
// `.value` (or nothing when reset-only). Anything else degrades to `undefined`
// so the caller's integer guard treats it as "no value to check".
function extractTimeoutValue(raw: unknown): unknown {
  if (isObject(raw)) {
    // A wrapper requesting a per-field reset may carry no `value`; that reset
    // contributes no value to validate, so an absent `value` reads as undefined.
    return 'value' in raw ? raw['value'] : undefined;
  }
  return raw;
}

// Local plain-object guard: true only for a non-null, non-array object (the
// shape of a parsed YAML mapping / overlay block).
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

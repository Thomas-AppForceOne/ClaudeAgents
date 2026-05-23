

/**
 * Tolerant JSON-object reading for state files (run progress, lock contents).
 *
 * These files are read on hot paths where a missing or corrupt file is a normal
 * condition, not an error to surface — so reads here never throw, returning
 * `undefined` instead. The companion {@link stripForbiddenKeys} guards against
 * prototype-pollution: parsed JSON is attacker-influenceable (it comes from
 * files on disk), so dangerous keys are dropped before the data is merged into
 * any object the framework subsequently uses.
 */
import { existsSync, readFileSync } from 'node:fs';

// Keys that can poison an object's prototype chain when copied in. Stripped by
// stripForbiddenKeys so untrusted JSON can never reach Object.prototype.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read and parse a JSON file that is expected to hold a plain object.
 *
 * @param filePath absolute path to the JSON file.
 * @returns the parsed object, or `undefined` in every non-object case: the file
 *   does not exist, cannot be read, is not valid JSON, or parses to `null`, an
 *   array, or a non-object scalar. Never throws — all failures collapse to
 *   `undefined` so callers can treat "absent" and "unusable" uniformly. The
 *   returned object is NOT prototype-sanitised; pass it through
 *   {@link stripForbiddenKeys} before merging it into a live object.
 */
export function readJsonObjectFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Return a shallow copy of `obj` with prototype-polluting keys
 * (`__proto__`, `constructor`, `prototype`) removed.
 *
 * @param obj an object parsed from untrusted JSON.
 * @returns a new object containing only the safe own-enumerable entries; the
 *   input is not mutated. Only top-level keys are filtered — nested objects are
 *   carried over by reference and are not deep-sanitised, which is sufficient
 *   here because callers spread the result one level deep.
 */
export function stripForbiddenKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

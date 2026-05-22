/**
 * Shared safe JSON-object file reader for the F7 storage modules.
 *
 * Run-state files under the central store (`progress.json`, `run.lock`) are read
 * back as UNTRUSTED input. {@link readJsonObjectFile} centralises the defensive
 * preamble every reader needs — an absent file, unreadable bytes, malformed
 * JSON, or a non-object (null / array / scalar) all collapse to `undefined`
 * rather than throwing — replacing a hand-rolled copy that previously lived in
 * three modules. {@link stripForbiddenKeys} additionally drops
 * prototype-polluting keys, for the readers that fold the parsed keys into a
 * merged object (rather than reading named scalar fields).
 */

import { existsSync, readFileSync } from 'node:fs';

/** Keys that must never be folded into a merged object (prototype-pollution guard). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read a JSON file into a plain object, or `undefined` when the file is absent,
 * unreadable, not valid JSON, or not a JSON object (null / array / scalar).
 * Never throws — malformed run-state on disk degrades to `undefined`.
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
 * Return a shallow own-property copy of `obj` with prototype-polluting keys
 * (`__proto__`, `constructor`, `prototype`) dropped. Use before folding a
 * parsed-from-disk object's keys into framework state (e.g. spreading it).
 */
export function stripForbiddenKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

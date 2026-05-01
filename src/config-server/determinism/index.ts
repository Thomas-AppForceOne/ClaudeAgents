/**
 * Centralised determinism pins for the config server.
 *
 * F3's determinism contract — picomatch glob, `realpathSync.native` path
 * canonicalisation, sorted-key JSON, locale-sensitive sort — is implemented
 * here and only here. Every other module imports from this entry point.
 * Duplicate implementations elsewhere are a regression and must be removed
 * via this module instead.
 */

import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Returns the subset of `candidates` matching `pattern` under the project's
 * pinned glob semantics (picomatch v4, default options). Output is
 * deterministic: matches are returned in `localeSort` order regardless of
 * input order.
 */
export function glob(pattern: string, candidates: string[]): string[] {
  const isMatch = picomatch(pattern, { dot: true });
  const matched = candidates.filter((c) => isMatch(c));
  return localeSort(matched);
}

/**
 * Canonicalise a filesystem path under F3's rules:
 * - resolve symlinks via `fs.realpathSync.native`
 * - strip a trailing slash (except for the filesystem root)
 * - lowercase the result on Darwin and Win32 (case-insensitive filesystems);
 *   leave bytes untouched on Linux
 *
 * If the path does not exist, falls back to `path.resolve` so callers can
 * canonicalise prospective paths (e.g. for path-escape checks) without
 * requiring the file on disk first.
 */
export function canonicalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  // Strip trailing slash unless this is the filesystem root.
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.slice(0, -1);
  }
  const plat = platform();
  if (plat === 'darwin' || plat === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/**
 * Stable JSON serialisation under F3's pin: keys sorted lexicographically at
 * every depth, two-space indent, trailing newline. `undefined` values and
 * function values are dropped (consistent with `JSON.stringify`).
 */
export function stableStringify(value: unknown): string {
  const sorted = sortKeysDeep(value);
  return JSON.stringify(sorted, null, 2) + '\n';
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Locale-sensitive sort under F3's pin: `localeCompare` with
 * `{ sensitivity: 'variant', numeric: false }`. Returns a new array; does not
 * mutate the input.
 */
export function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();
  copy.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }));
  return copy;
}

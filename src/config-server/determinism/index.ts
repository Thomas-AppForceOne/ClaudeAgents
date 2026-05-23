/**
 * Determinism primitives shared across the config-server.
 *
 * Config resolution must be reproducible: the same inputs must always produce
 * byte-identical output, regardless of filesystem iteration order, machine
 * locale, or platform path casing. This module is the one home for the
 * routines that enforce that — path canonicalisation, stable (key-sorted)
 * JSON serialisation, locale-stable sorting, and deterministic globbing.
 * Other modules must route through these rather than calling `JSON.stringify`,
 * `Array.sort`, or raw `realpathSync` ad hoc.
 */

import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Match `pattern` against `candidates` and return the matches, sorted stably.
 *
 * @param pattern a glob pattern (picomatch syntax). `dot: true` so leading-dot
 *   files like `.claude/...` are matched rather than skipped.
 * @param candidates the paths to test (already `/`-separated, project-relative).
 * @returns the matching subset, {@link localeSort}ed so the order does not
 *   depend on the candidates' input order.
 * @throws whatever `picomatch` throws when `pattern` is not a compilable glob;
 *   callers (e.g. detection) catch this to flag a malformed pattern.
 */
export function glob(pattern: string, candidates: string[]): string[] {
  const isMatch = picomatch(pattern, { dot: true });
  const matched = candidates.filter((c) => isMatch(c));
  return localeSort(matched);
}

/**
 * Canonicalise a path into the stable key form used for cache keys and
 * identity comparisons.
 *
 * Resolves symlinks and relativity via `realpathSync.native`, falling back to
 * `path.resolve` when the path does not exist on disk (so a not-yet-created
 * project root still produces a deterministic key). A single trailing slash is
 * trimmed, and on case-insensitive filesystems (macOS, Windows) the result is
 * lower-cased so two spellings of the same directory collapse to one key.
 *
 * @param p the path to canonicalise (absolute or relative).
 * @returns the canonical form; intended as an opaque identity key, NOT for
 *   display. Use {@link canonicalizePathForDisplay} when showing a path to a
 *   user, since the lower-casing here would otherwise mangle their casing.
 */
export function canonicalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }

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
 * Like {@link canonicalizePath} (symlink/relativity resolution, trailing-slash
 * trim) but WITHOUT the case-folding step, so the path is suitable to show to
 * a user on a case-insensitive filesystem. Never use this as a cache key — two
 * spellings of the same directory would not collapse.
 *
 * @param p the path to resolve for display.
 * @returns the resolved, original-cased path.
 */
export function canonicalizePathForDisplay(p: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Serialise `value` to JSON with deterministic, byte-stable output: object
 * keys are sorted recursively and `undefined`-valued keys are dropped, so two
 * structurally-equal values always serialise identically regardless of key
 * insertion order. This is the canonical form used for content hashing, on-disk
 * state files, and log lines.
 *
 * @param value any JSON-serialisable value (non-JSON values follow
 *   `JSON.stringify` semantics — functions/`undefined` dropped, etc.).
 * @returns 2-space-indented JSON with a single trailing newline (the trailing
 *   `\n` makes the output a well-formed text file / appendable log line).
 */
export function stableStringify(value: unknown): string {
  const sorted = sortKeysDeep(value);
  return JSON.stringify(sorted, null, 2) + '\n';
}

// Recursively rebuild `value` with object keys in sorted order. Arrays keep
// their order (position is meaningful); only mapping keys are reordered.
// `undefined` values are dropped so they never appear in the output and an
// optional-absent field never differs from an explicit-undefined one.
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
 * Sort strings into a stable, locale-independent order.
 *
 * @param items the strings to sort (not mutated — a copy is sorted).
 * @returns a new sorted array.
 *
 * The comparator pins `sensitivity: 'variant'` and `numeric: false` so the
 * ordering does not vary with the host machine's default locale or with
 * numeric-aware collation — the same inputs sort identically everywhere, which
 * is the whole point of routing all ordering through here.
 */
export function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();
  copy.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }));
  return copy;
}

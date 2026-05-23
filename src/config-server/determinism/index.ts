

import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

export function glob(pattern: string, candidates: string[]): string[] {
  const isMatch = picomatch(pattern, { dot: true });
  const matched = candidates.filter((c) => isMatch(c));
  return localeSort(matched);
}

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

export function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();
  copy.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }));
  return copy;
}

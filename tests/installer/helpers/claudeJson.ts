/**
 * R2 sprint 2 — `~/.claude.json` test helpers.
 *
 * `readClaudeJson()` returns the parsed structure (or null if the file
 * is absent). `assertNoTmpFiles()` enforces CC-NO-TMP — no leftover
 * `.tmp.*` siblings of `~/.claude.json` from a partial atomic write.
 * `assertSortedKeys()` checks that the on-disk JSON has lex-sorted
 * keys at every depth, 2-space indent, and a trailing newline.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ReadClaudeJsonResult {
  raw: string;
  parsed: Record<string, unknown>;
}

/**
 * Returns the raw text and parsed structure of `<home>/.claude.json`,
 * or null if the file does not exist.
 */
export function readClaudeJson(home: string): ReadClaudeJsonResult | null {
  const p = path.join(home, '.claude.json');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return { raw, parsed };
}

/**
 * Throws if any `<home>/.claude.json.tmp.*` sibling files remain on
 * disk. The S2 register-MCP path writes via `*.tmp.$$` then `mv`, so a
 * leftover indicates a non-atomic write or a crash mid-write.
 */
export function assertNoTmpFiles(home: string): void {
  const entries = readdirSync(home);
  const stragglers = entries.filter((e) => e.startsWith('.claude.json.tmp.'));
  if (stragglers.length > 0) {
    throw new Error(
      `CC-NO-TMP violation: leftover temp files in ${home}: ${stragglers.join(', ')}`,
    );
  }
}

/**
 * Throws if the supplied raw text does not have keys sorted lex at
 * every depth, 2-space indent, or a trailing newline. Re-parses and
 * re-stringifies with deterministic settings, then compares.
 */
export function assertSortedKeys(rawText: string): void {
  if (!rawText.endsWith('\n')) {
    throw new Error('Expected trailing newline on `.claude.json`');
  }
  const parsed = JSON.parse(rawText);
  const expected = sortedStringify(parsed, 2) + '\n';
  if (rawText !== expected) {
    throw new Error(`JSON not in sorted/2-space form. Got:\n${rawText}\nExpected:\n${expected}`);
  }
}

function sortedStringify(value: unknown, indent: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

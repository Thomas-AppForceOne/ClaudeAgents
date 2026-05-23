
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ReadClaudeJsonResult {
  raw: string;
  parsed: Record<string, unknown>;
}

export function readClaudeJson(home: string): ReadClaudeJsonResult | null {
  const p = path.join(home, '.claude.json');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return { raw, parsed };
}

export function assertNoTmpFiles(home: string): void {
  const entries = readdirSync(home);
  const stragglers = entries.filter((e) => e.startsWith('.claude.json.tmp.'));
  if (stragglers.length > 0) {
    throw new Error(
      `CC-NO-TMP violation: leftover temp files in ${home}: ${stragglers.join(', ')}`,
    );
  }
}

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

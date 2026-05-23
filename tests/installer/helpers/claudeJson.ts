/**
 * Assertion helpers for the installer's `~/.claude.json` write contract.
 *
 * `install.sh` registers the framework's config-server as an MCP entry inside
 * the user's `~/.claude.json`, and the installer's atomic-write discipline
 * promises three things these helpers verify across the suites:
 * - the merged document is rewritten as deterministic, sorted-key JSON with a
 *   2-space indent and a trailing newline (so re-runs are byte-stable and
 *   diffs stay clean) — see {@link assertSortedKeys};
 * - the temp-file-plus-rename write leaves no `.claude.json.tmp.*` straggler
 *   behind even after a crash mid-write — see {@link assertNoTmpFiles};
 * - the on-disk document round-trips back to parseable JSON — see
 *   {@link readClaudeJson}.
 *
 * The helpers throw with descriptive messages (rather than returning a flag)
 * so a failing assertion surfaces the offending text directly in the test
 * report.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Both views of a successfully-read `~/.claude.json`: the verbatim file text
 * (for byte-level assertions like sorted-key form) and its parsed object (for
 * structural assertions like "the MCP entry exists").
 *
 * @property raw the exact UTF-8 file contents, including the trailing newline.
 * @property parsed the JSON parse of `raw` as a plain object.
 */
export interface ReadClaudeJsonResult {
  raw: string;
  parsed: Record<string, unknown>;
}

/**
 * Read `<home>/.claude.json` and return both its raw text and parsed object.
 *
 * @param home the fake `$HOME` whose `.claude.json` to read.
 * @returns the {@link ReadClaudeJsonResult}, or `null` when the file is absent
 *   (the expected state for a `--no-claude-code` install, so callers branch on
 *   `null` rather than treating absence as an error).
 * @throws SyntaxError if the file exists but does not parse as JSON — a
 *   malformed write the test should fail loudly on.
 */
export function readClaudeJson(home: string): ReadClaudeJsonResult | null {
  const p = path.join(home, '.claude.json');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return { raw, parsed };
}

/**
 * Assert that no atomic-write temp files leaked into `home`. The installer
 * writes `~/.claude.json` via a `.claude.json.tmp.<suffix>` file that is then
 * renamed into place; a leftover temp file means a write was interrupted or
 * the rename never happened, which would betray the crash-safe write contract.
 *
 * @param home the fake `$HOME` to scan (non-recursively — temp files land
 *   directly beside `.claude.json`).
 * @throws Error naming every straggler when one or more `.claude.json.tmp.*`
 *   entries are present.
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
 * Assert that `rawText` is in the installer's canonical serialization form:
 * recursively key-sorted, indented with 2 spaces, and terminated by exactly
 * one trailing newline. This is the byte-stability contract that makes a
 * second install run produce a byte-identical file (and keeps version-control
 * diffs minimal).
 *
 * @param rawText the verbatim file contents to check (typically
 *   {@link ReadClaudeJsonResult.raw}).
 * @throws Error if the trailing newline is missing, or if re-serializing the
 *   parsed value in canonical form does not reproduce `rawText` byte-for-byte
 *   (the message includes both the actual and expected text for diffing).
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

// Serialize `value` with every object's keys in lexicographic order, matching
// the installer's deterministic-write format. The sort is what the installer
// guarantees; JSON.stringify alone would preserve insertion order instead.
function sortedStringify(value: unknown, indent: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

// Deep-copy `value` with every plain object's keys reordered lexicographically
// (arrays keep their element order; scalars pass through). Recurses so nested
// objects are sorted too, matching the installer's whole-document sort.
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

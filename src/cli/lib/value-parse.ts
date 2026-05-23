

/**
 * Coercion of a raw CLI argument string into the value that gets written to a
 * config/stack field.
 *
 * The shell hands every argument to the CLI as a string, but config values are
 * typed (numbers, booleans, lists, objects). This module bridges that gap with
 * a single "parse as JSON, else keep the literal string" rule, kept here so
 * `config set` and `stack update` coerce values identically.
 */

/**
 * Interpret a raw command-line value string as the typed value to store.
 *
 * Rules, in order:
 * - an empty string maps to the empty string `''` (never attempted as JSON, so
 *   `gan config set x ""` stores `""`, not a parse error);
 * - otherwise the input is parsed as JSON, so `8`, `true`, `null`, `[1,2]`,
 *   and `{"k":1}` become their typed equivalents;
 * - if JSON parsing throws, the raw string is returned verbatim — this is the
 *   intended fallback for bare words like `vitest`, not an error path.
 *
 * @param raw the exact argument string as received from the CLI.
 * @returns the parsed value (any JSON type) or, on parse failure, `raw`
 *   unchanged. Never throws — the `catch` turns the only failure into the
 *   string fallback.
 */
export function parseCliValue(raw: string): unknown {
  if (raw.length === 0) return '';
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * R3 sprint 3 — CLI value parser for write subcommands.
 *
 * `gan config set <path> <value>` and `gan stack update <name> <field> <value>`
 * receive `<value>` as a single shell-quoted argv string. The parser tries
 * `JSON.parse` first so callers can pass typed literals — booleans, numbers,
 * arrays, objects, or `null` — without escaping. If the JSON parse fails
 * (e.g. an unquoted bare word like `vitest`), the raw string is returned
 * verbatim. This keeps the common case ergonomic:
 *
 *   gan config set runner.thresholdOverride 8         → number 8
 *   gan config set foo.bar true                       → boolean true
 *   gan config set foo.list '[1,2,3]'                 → number array
 *   gan stack update generic testCmd "vitest run"     → string "vitest run"
 *
 * The parser is value-shape agnostic: schema validation is the writes
 * layer's job (R1 runs the JSON Schema check and rejects the mutation if
 * the resulting body would be invalid).
 *
 * Edge cases:
 *   - empty input ('')             → empty string ''
 *   - the literal string `null`    → JSON `null`
 *   - hex-like bare strings        → string (e.g. `0xff` is not valid JSON)
 *   - leading whitespace + JSON    → still parses (JSON.parse tolerates)
 *
 * Tests live in `tests/cli/lib/value-parse.test.ts`.
 */

/**
 * Try `JSON.parse(raw)`; fall back to the bare string. Never throws.
 *
 * The fallback is what gives bare-string ergonomics: callers don't need to
 * wrap simple word values in quotes the shell already swallowed.
 */
export function parseCliValue(raw: string): unknown {
  if (raw.length === 0) return '';
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

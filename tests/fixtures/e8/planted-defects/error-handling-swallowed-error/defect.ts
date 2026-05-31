/**
 * Defective `tryParse`: wraps a JSON parse in an empty `catch {}` and returns
 * `null` on any failure. The caller cannot distinguish "input was the literal
 * string `null`" from "input was malformed JSON", and the underlying error is
 * lost — no log line, no rethrow, no structured error.
 *
 * Out-of-contract bug: the initial contract only says "return the parsed
 * value or null"; the planted defect is the swallowed error, which a reviewer
 * recognises as a regression-against-debuggability vector.
 */

/**
 * Parse `raw` as JSON, returning the value or `null` when parsing fails.
 *
 * @param raw a JSON-encoded string. Untrusted.
 */
export function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // BUG: error swallowed silently. Should at minimum log + return a
    // sentinel that the caller can branch on, or rethrow a typed error.
    return null;
  }
}

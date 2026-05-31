/**
 * Defective email-validator implementation.
 *
 * Satisfies its INITIAL sprint contract ("return true for syntactically valid
 * email strings") yet contains a deliberate out-of-contract bug: the regex
 * uses `^…$` anchors with the `i` flag but no `m`-aware adjustment, and in
 * JavaScript `^` / `$` match line boundaries by default. A string of the form
 * `victim@host.tld\nBCC: attacker@evil.example` is therefore accepted as a
 * valid email even though it carries an injected mail-header line — the
 * classic CRLF / newline injection vector against naive header construction.
 *
 * The independent reviewer's pass is expected to surface this as a
 * blocker-severity finding with the reproduction command documented in the
 * sibling `manifest.json`. Do NOT use this module as a real email validator —
 * it is fixture data for the E8 fail-as-rejection acceptance case.
 */
const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

/**
 * Return `true` when `input` looks like a syntactically valid email address.
 *
 * @param input candidate email string. Untrusted; may originate from a form
 *   submission, an HTTP header, or a user-supplied config field.
 * @returns `true` when the input matches the anchored pattern; `false`
 *   otherwise. The bug is that the anchors match line boundaries, so a
 *   multi-line input whose first line is a valid address is wrongly accepted.
 */
export function validateEmail(input: string): boolean {
  if (typeof input !== 'string') return false;
  return EMAIL_PATTERN.test(input);
}

/**
 * R3 sprint 1 — thin output wrappers.
 *
 * `writeOut` and `writeErr` are the only sanctioned channels for the CLI to
 * emit text. Centralising them here means tests can spy on them in unit
 * coverage and means we never accidentally `console.log` (which appends a
 * newline we may not want, and goes via util.format which can re-encode).
 */

export function writeOut(s: string): void {
  process.stdout.write(s);
}

export function writeErr(s: string): void {
  process.stderr.write(s);
}

/**
 * R3 sprint 1 — thin output wrappers.
 *
 * `writeOut` and `writeErr` are the only sanctioned channels for the CLI to
 * emit text. Centralising them here means tests can spy on them in unit
 * coverage and means we never accidentally `console.log` (which appends a
 * newline we may not want, and goes via util.format which can re-encode).
 *
 * S3 adds `renderWriteResult` — the human-mode formatter for `gan config
 * set` and `gan stack update`. The JSON surface for the same writes flows
 * through `emitJson` directly (per the single-implementation rule); only
 * the human surface lives here.
 */

export function writeOut(s: string): void {
  process.stdout.write(s);
}

export function writeErr(s: string): void {
  process.stderr.write(s);
}

/**
 * Inputs to the human write-result renderer. `tier` is the overlay tier
 * for `config set` and the literal `'project'` for `stack update` (stack
 * writes always land on the project-tier shadow per C5). `name` is set
 * only for `stack update` (the stack name); `path` is the dotted field
 * path the user supplied; `value` is the parsed value that was written.
 */
export interface WriteResultRenderInput {
  /** Overlay tier or 'project' for stack-file writes. */
  tier: 'project' | 'user';
  /** Stack name (for `stack update`); omitted for `config set`. */
  name?: string;
  /** Dotted field path the user passed on the command line. */
  path: string;
  /** Parsed value that was actually written. */
  value: unknown;
}

/**
 * Render the human-mode success line for a write subcommand.
 *
 * Format:
 *   `gan config set`:    Updated `<path>` to `<json-value>` in <tier> overlay.
 *   `gan stack update`:  Updated `<path>` on stack `<name>` to `<json-value>`.
 *
 * `<json-value>` is the compact single-line JSON form of the value (so
 * booleans/numbers/strings/arrays render unambiguously without indent
 * noise). Determinism: human-mode write output is one line, never
 * compared byte-for-byte across runs (callers wanting determinism use
 * `--json`), so the F3 sorted-keys pin is unnecessary here. We render
 * via `JSON.stringify` with no indent for compactness.
 */
export function renderWriteResult(input: WriteResultRenderInput): string {
  const compact = JSON.stringify(input.value);
  if (input.name === undefined) {
    return `Updated \`${input.path}\` to \`${compact}\` in ${input.tier} overlay.\n`;
  }
  return `Updated \`${input.path}\` on stack \`${input.name}\` to \`${compact}\`.\n`;
}



/**
 * Low-level output sinks plus the human-readable render of a successful write.
 *
 * Commands never touch `process.stdout`/`process.stderr` directly; they go
 * through {@link writeOut}/{@link writeErr} so the single point of contact with
 * the streams stays here (and stays easy to intercept in tests). The
 * write-result renderer lives alongside them because it produces the
 * confirmation line printed after a mutating command succeeds.
 */

/**
 * Write `s` to stdout exactly as given — no trailing newline is appended, so
 * the caller controls line breaks. The CLI's sole stdout sink.
 *
 * @param s the bytes to emit (rendered output or JSON).
 */
export function writeOut(s: string): void {
  process.stdout.write(s);
}

/**
 * Write `s` to stderr exactly as given — no trailing newline appended. The
 * CLI's sole stderr sink, used for error and usage text so it never pollutes
 * the `--json` payload on stdout.
 *
 * @param s the bytes to emit (error or diagnostic text).
 */
export function writeErr(s: string): void {
  process.stderr.write(s);
}

/**
 * Describes a single successful field write, for rendering its confirmation.
 *
 * @property tier which overlay tier was written (`project` or `user`); shown
 *   only for overlay writes (when `name` is absent).
 * @property name the stack name when the write targeted a stack file; its
 *   presence is the discriminator that selects the stack-phrasing branch in
 *   {@link renderWriteResult}. Omit it for an overlay write.
 * @property path the dotted field path that was set.
 * @property value the value written; rendered compactly via `JSON.stringify`.
 */
export interface WriteResultRenderInput {

  tier: 'project' | 'user';

  name?: string;

  path: string;

  value: unknown;
}

/**
 * Render the one-line, newline-terminated confirmation printed after a
 * successful overlay or stack field write.
 *
 * The phrasing branches on `input.name`: when absent the message names the
 * overlay tier ("...in <tier> overlay."); when present it names the stack
 * ("...on stack `<name>`."). `tier` is therefore only surfaced on the overlay
 * branch.
 *
 * @param input see {@link WriteResultRenderInput}.
 * @returns the confirmation line, terminated with a trailing `\n`.
 */
export function renderWriteResult(input: WriteResultRenderInput): string {
  // Compact (not pretty) JSON: this is a single inline confirmation line, so
  // the value must render on one line regardless of its shape.
  const compact = JSON.stringify(input.value);
  if (input.name === undefined) {
    return `Updated \`${input.path}\` to \`${compact}\` in ${input.tier} overlay.\n`;
  }
  return `Updated \`${input.path}\` on stack \`${input.name}\` to \`${compact}\`.\n`;
}

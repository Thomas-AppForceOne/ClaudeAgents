/**
 * Shared structured-error helpers for the `gan` CLI surface.
 *
 * Two surface contracts every command observes:
 *
 * 1. **Structured envelopes under `--json`.** A failure-path stderr
 *    payload is always a single-line JSON envelope `{code,
 *    subReason, message}` followed by `\n`. A CI gate that parses
 *    `--json` stderr can therefore `JSON.parse(stderr.trim())`
 *    without branching on the originating command.
 *
 * 2. **Prose under the default (interactive) path.** An operator
 *    running `gan hooks migrate --delete` without `--json` sees a
 *    readable two-line failure message (the human-facing
 *    `message` plus a parenthesised `code`/`subReason` annotation),
 *    not the raw JSON envelope. The whole rest of the `gan` CLI
 *    treats `--json` as opt-in to machine output; structured-error
 *    commands must follow that precedent.
 *
 * The two helpers below close both contracts: `cliError(...)`
 * builds the envelope (every failure path uses it), and
 * `presentErrorAsProse(result)` converts a `CommandResult` whose
 * stderr is an envelope into the prose form when `--json` is
 * absent. Commands compose them by always emitting envelopes from
 * the inner handler and routing the result through
 * `presentErrorAsProse` at the dispatch boundary when `--json`
 * was not requested.
 */

/**
 * Result contract every `gan` CLI command's `run` produces.
 *
 * @property stdout text destined for stdout (rendered output, JSON,
 *   or empty on failure paths).
 * @property stderr text destined for stderr (a JSON envelope from
 *   {@link cliError}, prose from {@link presentErrorAsProse}, or
 *   empty on success paths).
 * @property code the process exit code to return.
 */
export interface CliCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Build a structured-error stderr payload. The envelope is a single
 * JSON line plus a trailing newline so a downstream consumer can
 * either `JSON.parse(stderr.trim())` directly or trim the stream
 * boundary before parsing.
 *
 * @param code the PascalCase machine token registered in
 *   {@link import('./exit-codes.js').TABLE}. `exitCodeFor()`
 *   resolves it to the right exit value so the call site does not
 *   have to repeat the mapping.
 * @param subReason the per-failure-class discriminator scoped to
 *   the emitting command. Both `hooks-migrate` and `hooks-status`
 *   maintain their own closed unions; the cross-command
 *   namespace is the `code` token.
 * @param message single-line operator-facing prose. Keep it under
 *   one line so a log reader piping stderr through `jq` does not
 *   have to handle multi-line payloads.
 * @returns the envelope plus trailing `\n`, ready to assign to a
 *   `CommandResult.stderr` field.
 */
export function cliError(code: string, subReason: string, message: string): string {
  return JSON.stringify({ code, subReason, message }) + '\n';
}

/**
 * Convert a `CommandResult` whose `stderr` carries a {@link
 * cliError} envelope into the prose-formatted equivalent the
 * default (interactive) path emits. A `--json`-opted-in caller
 * skips this step and forwards the envelope verbatim.
 *
 * The prose shape is two lines: `Error: <message>` followed by a
 * parenthesised `(code: <code>, subReason: <subReason>)`
 * annotation. The annotation is load-bearing for a CI gate that
 * forgot to pass `--json` — it can still branch on the code
 * without needing structured output.
 *
 * Pass-through behaviour: when `result.stderr` is not a JSON
 * envelope (e.g. an empty success result, or a future call site
 * that genuinely needs raw stderr), the function returns the
 * input unchanged. This makes the conversion safe to apply
 * unconditionally at the dispatch boundary.
 *
 * @param result the inner command result, normally produced by a
 *   `runInner`-style handler that always emits envelopes.
 * @returns the result with `stderr` rewritten to prose when an
 *   envelope is present; the original result otherwise.
 */
export function presentErrorAsProse(result: CliCommandResult): CliCommandResult {
  const trimmed = result.stderr.trim();
  if (!trimmed.startsWith('{')) return result;
  let parsed: { code?: unknown; subReason?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    // stderr looked envelope-ish but did not parse as JSON.
    // Leave the raw text rather than risk munging an unrelated
    // payload.
    return result;
  }
  // Only rewrite when all three envelope fields are present AND
  // string-typed. A leading-`{` payload that parsed as JSON but
  // lacks the envelope shape (e.g. a future debug dump or an
  // unrelated structured payload bubbling up from a helper) would
  // otherwise be rewritten with empty `(code: , subReason: )`
  // annotations — strictly worse than passing the original text
  // through verbatim.
  if (
    typeof parsed.code !== 'string' ||
    typeof parsed.subReason !== 'string' ||
    typeof parsed.message !== 'string'
  ) {
    return result;
  }
  return {
    ...result,
    stderr: `Error: ${parsed.message}\n  (code: ${parsed.code}, subReason: ${parsed.subReason})\n`,
  };
}

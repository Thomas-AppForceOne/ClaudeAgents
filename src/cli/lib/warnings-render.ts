/**
 * Shared human-readable rendering of resolved-config warnings.
 *
 * W1 surfaces the same warning prose in three places (the orchestrator startup
 * log, `gan stacks list`, and `gan config print`). To keep ONE warning-prose
 * source across every CLI surface — so the prose can never drift between
 * commands — both human renderers route through {@link renderWarningProse}
 * here. The helper reads only the warning's `code` and `message`, which the
 * data layer already guaranteed are value-safe (a per-stack override's command
 * VALUE is never carried on the warning), so a rendering surface cannot
 * re-introduce a secret leak by reaching past these fields to the raw overlay.
 */

import type { Warning } from '../../index.js';

/**
 * Render one warning as a single human-readable prose line, in the same
 * `<code>: <message>` shape the orchestrator startup log emits.
 *
 * @param warning the warning to render; only its `code` and `message` are read.
 *   `message` is the data layer's already-composed, value-safe prose — this
 *   helper neither reshapes it nor reads `details` (and so never the raw
 *   override value).
 * @returns the line `"<code>: <message>"` with NO trailing newline; the caller
 *   joins lines and controls line breaks. Pure: never throws, no side effects.
 */
export function renderWarningProse(warning: Warning): string {
  return `${warning.code}: ${warning.message}`;
}

/**
 * Render a list of warnings as a multi-line human-readable block, one
 * {@link renderWarningProse} line per warning, in array order.
 *
 * @param warnings the warnings to render, read verbatim from the snapshot in
 *   the order the data layer produced them (the CLI never re-sorts or
 *   recomputes them).
 * @returns the lines joined by `\n` with NO trailing newline (the caller frames
 *   the block); an empty string when `warnings` is empty, so a caller can test
 *   the result before deciding whether to emit a section header. Pure: never
 *   throws, no side effects.
 */
export function renderWarningLines(warnings: readonly Warning[]): string {
  return warnings.map(renderWarningProse).join('\n');
}

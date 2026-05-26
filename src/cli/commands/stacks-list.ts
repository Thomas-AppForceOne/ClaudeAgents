/**
 * `gan stacks list` — print the stacks currently *active* in the resolved
 * config for a project (the ordered `stacks.active` list), as opposed to
 * `gan stacks available` which lists every built-in stack on disk.
 *
 * W1 extends the command with the resolved config's non-aborting `warnings`:
 * `--json` always carries a top-level `warnings` array, and the human format
 * grows an active-vs-suppressed breakdown when (and only when) a
 * `StackOverrideShrinkage` warning is present. To surface warnings without
 * recomputing anything, the body reads the full snapshot via
 * {@link getResolvedConfig} — `active` is still that snapshot's
 * `stacks.active`, identical to what `getActiveStacks` returns, so the
 * script-friendly active set is unchanged.
 *
 * A read-only command: it never writes and delegates project-root resolution,
 * `--json` handling, and error mapping to {@link runRead}.
 */

import { getResolvedConfig } from '../../index.js';
import { runRead, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';
import type { ResolvedConfig, Warning } from '../../index.js';

/**
 * Shape rendered by {@link renderHuman} and emitted under `--json`.
 *
 * The previous `{ active }` payload is preserved verbatim (so existing
 * consumers and the F-AC5 parity test keep reading `active` unchanged); the
 * `warnings` array is an addition, never a replacement.
 *
 * @property active the active stack names in resolution order; an empty array
 *   means no stack is active (a valid state, not an error). Read from the
 *   snapshot's `stacks.active` — the command does not re-derive activation.
 * @property warnings the snapshot's non-aborting warnings, read verbatim and in
 *   the data layer's order; an empty array when none apply, so `--json`
 *   consumers never branch on the key's absence.
 */
interface StacksListResponse {
  active: string[];
  warnings: Warning[];
}

/**
 * Project the resolved config down to the {@link StacksListResponse} the
 * command renders.
 *
 * @param resolved the fully resolved config (the single source of truth).
 * @returns `{ active, warnings }` — defensive copies (`.slice()`) of the
 *   snapshot arrays, so neither the JSON payload nor the human renderer can
 *   mutate the resolver's internal state. Pure: never throws.
 */
function toResponse(resolved: ResolvedConfig): StacksListResponse {
  return {
    active: resolved.stacks.active.slice(),
    warnings: resolved.warnings.slice(),
  };
}

/**
 * The remediation pointer printed below the active-vs-suppressed breakdown.
 *
 * Pinned to the W1 spec's `gan stacks list` example verbatim. Kept as a module
 * constant (not inlined) so the two lines stay a single edit point matching the
 * spec golden.
 */
const SHRINKAGE_REMEDIATION = [
  'For full coverage, list every stack you want active in stack.override.',
  'See `gan stacks --help` for the active-vs-available distinction.',
];

/**
 * Render the active-stacks response for human (non-JSON) output.
 *
 * Two output shapes, gated strictly on the presence of a
 * `StackOverrideShrinkage` warning — and ONLY that code. The breakdown exists to
 * explain a shrunk active set, so only the shrinkage warning may trigger it; a
 * future overlay warning of any other code must NOT, which is why the gate keys
 * on the shrinkage code rather than on "any warning present". This keeps the
 * script-friendly path (one name per line) byte-for-byte unchanged whenever no
 * coverage was lost.
 *
 * - No shrinkage warning: one active stack name per line (trailing newline), or
 *   the literal `(none)\n` when the active set is empty. Byte-for-byte the
 *   pre-W1 behaviour, for scripting compatibility.
 * - Shrinkage warning present: the annotated breakdown — an `ACTIVE for this
 *   directory:` block, a blank line, a `SUPPRESSED by stack.override:` block
 *   (each name annotated), a blank line, then the remediation pointer. The
 *   active and suppressed names are read from the snapshot (the active set and
 *   the warning's `details.suppressed`); detection is never recomputed here.
 *
 * @param resp the projected active/warnings response.
 * @returns the rendered human text with a trailing newline.
 */
function renderHuman(resp: StacksListResponse): string {
  // Find the shrinkage warning by its machine code (never by message text,
  // which is advisory and may change). Its `details.suppressed` lists the
  // stacks the override dropped — read straight from the snapshot.
  const shrinkage = resp.warnings.find((w) => w.code === 'StackOverrideShrinkage');

  if (!shrinkage || shrinkage.details.code !== 'StackOverrideShrinkage') {
    // Script-friendly path, unchanged: one name per line, `(none)` on empty.
    if (resp.active.length === 0) return '(none)\n';
    return resp.active.join('\n') + '\n';
  }

  const suppressed = shrinkage.details.suppressed;
  const lines: string[] = [];
  lines.push('ACTIVE for this directory:');
  for (const name of resp.active) {
    lines.push(`  ${name}`);
  }
  lines.push('');
  lines.push('SUPPRESSED by stack.override:');
  for (const name of suppressed) {
    lines.push(`  ${name} (would have been activated by detection)`);
  }
  lines.push('');
  lines.push(...SHRINKAGE_REMEDIATION);
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan stacks list`.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root` via the
 *   shared {@link runRead} wrapper. Under `--json` the {@link StacksListResponse}
 *   is serialised through the deterministic JSON helper, so the top-level
 *   `warnings` array is always present with stable key ordering.
 * @returns a {@link CommandResult}; exit code is OK on success or an
 *   error-mapped code if project-root resolution / config load throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  return runRead(
    parsed,
    async (projectRoot) => toResponse(await getResolvedConfig({ projectRoot })),
    renderHuman,
  );
}

/**
 * The verbatim ten-row `terminalReason → disposition` mapping table.
 *
 * O2 defines the `terminalReason` vocabulary (the run's terminal-outcome
 * code); O3 defines `disposition` (the user-facing five-value bucket). Every
 * terminalReason maps to exactly one disposition — implementers must not
 * guess, and the mapping must live in exactly one place so a new O2 code
 * adds its row here in the same change rather than fanning out duplicated
 * switches across writers. The outcome.json writer and any future consumer
 * (T2 stats surface, recovery reporting) reaches the disposition through
 * {@link terminalReasonToDisposition}; an inline switch elsewhere is a
 * defect the contract pins.
 *
 * The deliberate vocabulary mismatch — most `aborted-*` terminalReason
 * codes do NOT map to the `aborted` disposition — is intentional:
 * `aborted-` is historical naming on the reason side, while disposition is
 * semantic (user-initiated vs failure). Only the user-initiated
 * `aborted-by-user` maps to the `aborted` disposition.
 */

import type { Disposition, TerminalReason } from './types.js';

/**
 * Map an O2 `terminalReason` to its O3 `disposition` per the spec's
 * ten-row table.
 *
 * @param reason the O2 terminalReason. The function accepts the typed
 *   {@link TerminalReason} union; a value outside the union is a typecheck
 *   error (see the `never`-typed default arm) so a misspelled or
 *   recently-added code surfaces at compile time rather than at runtime.
 * @returns the corresponding {@link Disposition}.
 *
 * Failure modes: none at runtime when the input is a typed
 * {@link TerminalReason}. The default arm exists only to make a forgotten
 * row a compile-time error; the throw is a defence-in-depth for the case
 * of an untyped cast at the call site.
 */
export function terminalReasonToDisposition(reason: TerminalReason): Disposition {
  switch (reason) {
    case 'complete':
      return 'success';
    case 'failed-evaluation-rejected':
      return 'rejected';
    case 'aborted-contract-failed':
      // Pre-generation contract negotiation refusal — a refusal, not a
      // crash, so it shares the post-generation gate's `rejected` bucket
      // rather than `aborted` (which is user-initiated only).
      return 'rejected';
    case 'failed-max-attempts':
      return 'halted';
    case 'failed-budget':
      return 'halted';
    case 'failed-loop-detected':
      return 'halted';
    case 'aborted-by-user':
      return 'aborted';
    case 'failed-clarifier-error':
      return 'errored';
    case 'aborted-planner-error':
      return 'errored';
    case 'aborted-validation-failed':
      // Included for taxonomy completeness: per O2 this code is recorded
      // when validateAll() halts before the run dir exists, so an
      // outcome.json carrying it cannot actually be written under the
      // normal flow. The row is present so the table is exhaustive over
      // the ten O2 codes — a missing arm would surface as a never-typed
      // default at any call site that passed the code.
      return 'errored';
    default: {
      // Exhaustiveness guard: if a new TerminalReason value is added to
      // the union without a row here, the assignment to `never` fails the
      // typecheck. The runtime throw is the defence-in-depth path for an
      // untyped cast at the call site.
      const exhaustive: never = reason;
      throw new Error(`Unrecognised terminalReason: ${exhaustive as string}.`);
    }
  }
}

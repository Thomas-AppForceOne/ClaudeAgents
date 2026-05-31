/**
 * Revision-scoped trace recovery — derive the per-role attempt tally for a
 * single contract revision from the run's event log.
 *
 * Sibling to the shipped {@link reconstructRecoveryState}, not an edit of it.
 * The shipped helper sums every `agentAttempt` event across the whole trace
 * (revision-agnostic by design — the safety budget it feeds was authored
 * before the contract had revisions); modifying it to filter would change its
 * semantics for every existing caller. A separate helper preserves the
 * whole-trace accounting unchanged for the existing budget path and offers a
 * narrower view for the revision-bounded path.
 *
 * Why the missing-field default is revision 0: the `contractRevision` field
 * on `agentAttempt` events is additive and optional. A trace written before
 * the field existed, or by a producer that does not stamp it, carries
 * attempts that semantically belong to the original locked contract — which
 * is revision 0 by convention. Counting an unstamped attempt against
 * revision 0 (rather than dropping it) preserves backward compatibility for
 * pre-existing traces and matches the convention the renegotiation lifecycle
 * documents.
 *
 * Pure function with no side effects: it reads the events directory through
 * the same `scanEvents` the shipped recovery helper uses, applies a single
 * filter, and folds the survivors into a per-role tally. Determinism on the
 * same trace follows from the underlying scanner's deterministic ordering.
 */

import { scanEvents } from './reconcile.js';
import type { RecoveryState, RoleAttemptState } from './reconcile.js';

// Keys that must never index the role-keyed accumulator: they are the
// prototype-pollution vectors. Mirrors the discipline in
// `src/trace/reconcile.ts` and the budget folder so a hostile `__proto__`-
// named role in parsed trace data cannot pollute `Object.prototype` or
// admit a phantom role into the revision-scoped tally.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The per-role attempt accounting reconstructed for a single contract
 * revision.
 *
 * Re-exports the shipped {@link RecoveryState} shape verbatim so a downstream
 * consumer (e.g. `checkSprintBudget`, `checkRoleCeiling`) can ingest a
 * revision-scoped tally and a whole-trace tally through the same input type
 * — no adapter code, no parallel definition. The intentional alias also
 * keeps a single source of truth: a future change to the recovery-state
 * shape lands once and propagates to every caller of either helper.
 */
export type RevisionState = RecoveryState;

/**
 * Reconstruct the per-role attempt tally for a single contract revision.
 *
 * Filters `agentAttempt` events by `contractRevision`. An event whose
 * `contractRevision` field is absent is treated as belonging to revision 0
 * (see this module's docblock for the rationale: additive optional field,
 * pre-existing traces, convention that the original locked contract is
 * revision 0). Attempts for any other revision are skipped from the fold.
 *
 * The returned shape matches the shipped {@link RecoveryState} exactly so the
 * caller can pipe the result straight into the existing safety checks
 * (`checkSprintBudget`, `checkRoleCeiling`) without an adapter layer. The
 * `nextSequence` field is preserved from the whole-trace scan (it is a
 * resume-point property of the trace, not of any one revision) so a caller
 * that wants both the revision-scoped tally and a safe resume sequence reads
 * them from one call.
 *
 * @param traceRoot the trace root to scan (the directory containing the
 *   `events/` subdirectory). The function reads only what `scanEvents` reads;
 *   no other I/O.
 * @param contractRevision the revision to filter to. Non-negative integers
 *   matching the schema constraint; behaviour for negative values is
 *   undefined by contract but the schema guards the producer side so no such
 *   value can be present on a validated event.
 * @returns a {@link RevisionState}: `attemptStateByRole` containing only the
 *   roles with at least one attempt at the requested revision, and
 *   `nextSequence` carried over from the whole-trace scan. An empty/absent
 *   trace yields `{ nextSequence: 0, attemptStateByRole: {} }`. Pure; never
 *   throws.
 */
export function reconstructRevisionState(
  traceRoot: string,
  contractRevision: number,
): RevisionState {
  const { events, unknownClassEvents } = scanEvents(traceRoot);

  // -1 sentinel so an empty trace yields nextSequence = 0 (highest + 1).
  let highestSequence = -1;
  // Null-prototype map so a role name cannot collide with an inherited
  // member; matches the discipline of `reconstructRecoveryState`.
  const attemptStateByRole: Record<string, RoleAttemptState> = Object.create(null) as Record<
    string,
    RoleAttemptState
  >;

  // Include unknown-class events in the high-water mark so a resumed run
  // never reuses a sequence number a future-version event already wrote —
  // this is a trace-wide property, independent of the revision filter.
  for (const ev of unknownClassEvents) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;
  }

  for (const ev of events) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;

    if (ev.eventType !== 'agentAttempt') continue;

    // Missing-field default: undefined → 0. An attempt event predating the
    // field existence belongs to the original locked contract by
    // convention, so it is counted against revision 0 rather than dropped.
    const eventRevision = ev.contractRevision ?? 0;
    if (eventRevision !== contractRevision) continue;

    const role = ev.role;
    // Defence-in-depth: a pollution-named role here would index the
    // accumulator; skip it before it can. `reconstructRecoveryState` applies
    // the same guard for the same reason.
    if (FORBIDDEN_ROLE_KEYS.has(role)) continue;

    // hasOwnProperty (not `in`/truthiness) because the accumulator is
    // null-prototype and a role's prior state could legitimately be falsy.
    const prior = Object.prototype.hasOwnProperty.call(attemptStateByRole, role)
      ? attemptStateByRole[role]!
      : { attemptCount: 0, highestAttemptNumber: 0 };
    // defineProperty (not assignment) so even a forbidden key reaching this
    // point would create a real own property rather than walking the
    // prototype setter — same install discipline the recovery folder uses.
    Object.defineProperty(attemptStateByRole, role, {
      value: {
        attemptCount: prior.attemptCount + 1,
        // Track max attemptNumber separately so a gap in the log cannot let
        // count and highest disagree — the recovery folder does the same.
        highestAttemptNumber: Math.max(prior.highestAttemptNumber, ev.attemptNumber),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    nextSequence: highestSequence + 1,
    attemptStateByRole,
  };
}

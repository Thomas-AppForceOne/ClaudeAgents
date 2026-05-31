/**
 * Terminal-reason record builder for a renegotiation round that failed at
 * the cap with unresolved blocking findings.
 *
 * When the renegotiation cap fires while at least one `blocker`-severity
 * finding remains unresolved, the run terminates as an evaluation failure:
 * the framework's gate said no, the work was not accepted. This is
 * semantically distinct from the loop-detection halts shipped under the
 * `LoopDetected` umbrella (`failed-loop-detected`), which signal genuine
 * non-convergence detected by the per-role ceiling, the sprint-wide budget,
 * or the edit-oscillation detector. Treating a cap-with-blockers exit as
 * "the gate rejected this work" rather than as thrash preserves the
 * distinction a user needs to act on it: a rejection is recoverable by
 * fixing the flagged defect; thrash recovery is about adjusting the prompt
 * or raising a ceiling.
 *
 * Shape: a pure builder symmetric with `buildLoopHaltTerminalRecord` in
 * `src/safety/recovery.ts`. The builder decides whether to write (via the
 * two cap-vs-blockers guards) and, on a write decision, returns the
 * fields the caller must merge into `progress.json`. Persistence is the
 * caller's responsibility — the MCP wrapper in
 * `src/config-server/tools/independent-review.ts` composes builder +
 * shared persister (`writeProgressFields` from `./progress.ts`) +
 * atomic-write into one tool call, mirroring the wire shape every other
 * progress-affecting MCP tool follows. A TS caller that needs the same
 * behaviour invokes the builder then `writeProgressFields(...)` on the
 * record fields directly.
 *
 * Why a separate builder from `buildLoopHaltTerminalRecord` (which builds
 * the `failed-loop-detected` record): the two reasons gate on different
 * conditions and carry different semantics. Co-locating them would couple
 * unrelated decisions; a sibling builder keeps each call site narrow ("the
 * renegotiation cap fired with blockers" vs "a loop halt fired") and lets a
 * reader see which terminal class is being recorded without untangling
 * shared branching.
 *
 * Why the builder is a no-op when `capFired` is false OR
 * `unresolvedBlockers` is empty: writing `terminal: true` is irreversible
 * from the caller's perspective — once the field lands on disk, `--recover`
 * keys on it and the run is considered terminated. A spurious write in
 * either of these cases would mark a non-terminal run as terminated. The
 * builder therefore defends both conditions with an explicit guard: a
 * finished round with zero blockers is a passing renegotiation, not a
 * rejection, and a round that has not yet reached the cap should not be
 * terminated by the renegotiation accounting at all.
 */

/**
 * The kebab-case `terminalReason` literal a renegotiation-cap-with-blockers
 * rejection records on `progress.json`.
 *
 * **Why exactly this literal:** `terminalReason` codes are kebab-case ASCII
 * matching the existing recoverable-terminal convention shared with the
 * loop-detection record. A divergent spelling (camelCase, a different word,
 * a typo) would make the rejected run un-discoverable to any consumer
 * keyed on this exact value. Frozen at the source for the same reason
 * {@link FAILED_LOOP_DETECTED_TERMINAL_REASON} is frozen for its halt class.
 */
export const FAILED_EVALUATION_REJECTED_TERMINAL_REASON = 'failed-evaluation-rejected';

/**
 * Minimal shape of an unresolved blocking finding the builder inspects.
 *
 * The builder does not introspect any field beyond the array's length — it
 * only needs to know whether at least one blocker survived the round. A
 * loose `id` is named here so callers can pass their existing finding
 * records without reshaping them; additional fields are tolerated and
 * ignored. Defining the shape narrowly (rather than `unknown`) makes the
 * call-site contract self-documenting: a caller passing an unrelated array
 * gets a TS error rather than a silent acceptance.
 */
export interface UnresolvedBlockerLike {
  id: string;
  [key: string]: unknown;
}

/**
 * Inputs to {@link buildFailedEvaluationRejectedRecord}.
 *
 * @property capFired `true` when the orchestrator decided the renegotiation
 *   cap has fired this sprint, `false` otherwise. The builder treats a
 *   `false` value as a no-op so a caller that wires the guard at the wrong
 *   site cannot accidentally mark a non-terminal run as terminated.
 * @property unresolvedBlockers the surviving `blocker`-severity findings at
 *   the moment the cap fired. The builder inspects only the length; an
 *   empty array (cap fired but every blocker was resolved) is treated as
 *   "the round actually passed, do not terminate" — a renegotiation that
 *   converges right at the cap is a pass, not a rejection.
 */
export interface BuildFailedEvaluationRejectedOptions {
  capFired: boolean;
  unresolvedBlockers: ReadonlyArray<UnresolvedBlockerLike>;
}

/**
 * The persisted fields the builder produces on a write decision.
 *
 * @property terminal always `true`: a cap-with-blockers rejection ends the
 *   run.
 * @property terminalReason the kebab-case rejection reason; always
 *   {@link FAILED_EVALUATION_REJECTED_TERMINAL_REASON}.
 */
export interface FailedEvaluationRejectedRecord {
  terminal: true;
  terminalReason: typeof FAILED_EVALUATION_REJECTED_TERMINAL_REASON;
}

/**
 * Result of {@link buildFailedEvaluationRejectedRecord}.
 *
 * @property write `true` when the builder decided the terminal record must
 *   be persisted (the cap fired AND at least one unresolved blocker
 *   survived); `false` on a no-op decision (cap not fired, or no unresolved
 *   blockers). A no-op is reported explicitly so the caller can log it for
 *   the trace without having to re-derive the guard conditions.
 * @property record present only when `write` is `true`: the
 *   {@link FailedEvaluationRejectedRecord} the caller (or the MCP wrapper)
 *   merges into `progress.json` via `writeProgressFields` from
 *   `./progress.ts`. Returning the record (rather than just `true`) gives
 *   the caller a single source of truth it can echo into a structured
 *   warning or test assertion without re-importing the literal.
 */
export interface BuildFailedEvaluationRejectedResult {
  write: boolean;
  record?: FailedEvaluationRejectedRecord;
}

/**
 * Build the `failed-evaluation-rejected` terminal-reason record when, and
 * only when, the renegotiation cap has fired with at least one unresolved
 * blocking finding. Pure — no I/O, no global state, no `Promise`.
 *
 * Behaviour:
 * - If `capFired === false` OR `unresolvedBlockers.length === 0`, the
 *   builder is a no-op: returns `{ write: false }` and no record. The
 *   two guards together protect against spuriously marking a non-terminal
 *   run terminated (see the module docblock for why a single guard is not
 *   enough).
 * - Otherwise the builder returns
 *   `{ write: true, record: { terminal: true, terminalReason: "failed-evaluation-rejected" } }`.
 *   The caller (typically the MCP wrapper in
 *   `src/config-server/tools/independent-review.ts`) merges the record
 *   into `progress.json` via the shared persister.
 *
 * Symmetric with `buildLoopHaltTerminalRecord` in
 * `src/safety/recovery.ts`: both are pure builders returning the fields
 * their respective terminal class records, and both leave persistence to a
 * thin caller layer that consumes the shared `progress.json` read-modify-
 * write primitive. Symmetric builders mean the wire-side MCP tool calls
 * for the two terminal classes have the same shape (compose builder +
 * persister), which is what lets the markdown orchestrator route both
 * terminal writes through one tool-call pattern instead of two bespoke
 * recipes.
 *
 * @param opts see {@link BuildFailedEvaluationRejectedOptions}.
 * @returns a {@link BuildFailedEvaluationRejectedResult}.
 */
export function buildFailedEvaluationRejectedRecord(
  opts: BuildFailedEvaluationRejectedOptions,
): BuildFailedEvaluationRejectedResult {
  const { capFired, unresolvedBlockers } = opts;

  // Guard 1: the cap has not fired. The renegotiation accounting only marks
  // a run terminal when the orchestrator has decided that further rounds
  // are not permitted; a not-yet-fired round must not be terminated by this
  // builder, even if blockers are present (they may still be resolved in a
  // later round under the cap).
  if (!capFired) {
    return { write: false };
  }

  // Guard 2: cap fired but zero blockers survived. A renegotiation that
  // converges right at the cap (every blocker resolved by the final round)
  // is a pass, not a rejection — the gate did not say no. Writing
  // `terminal: true` here would falsely terminate a passing run.
  if (unresolvedBlockers.length === 0) {
    return { write: false };
  }

  return {
    write: true,
    record: {
      terminal: true,
      terminalReason: FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
    },
  };
}

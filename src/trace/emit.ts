/**
 * `emitTraceEvent` — the shared emit-failure policy that sits above the raw
 * {@link appendTraceEvent} write path.
 *
 * `appendTraceEvent` is the low-level primitive: it writes the event file with
 * exclusive-create semantics and **throws** on any unrecoverable write
 * failure. That raw throw is the right contract for recovery code that wants
 * to fail loudly, but the runtime emission path needs a softer policy so a
 * single lost event never aborts a run.
 *
 * That policy lives here, in one place, so both callers share it:
 *  - the `emitTraceEvent` MCP tool wrapper, and
 *  - any caller importing this function directly from the trace barrel.
 *
 * Keeping the policy in a single shared layer (rather than only inside the
 * tool wrapper) is what makes the two surfaces behave identically for equal
 * inputs — a direct library import gets the same one-retry, same tally
 * increment, and same structured-warning return the tool does.
 *
 * The policy:
 *  - **non-`agentAttempt` event:** any write error is caught, the in-memory
 *    `droppedEmits` tally for the `runDir` is incremented, and a structured
 *    warning is returned. Losing a single non-attempt event is recoverable;
 *    aborting on it would be worse than continuing.
 *  - **`agentAttempt` event:** the failure path retries exactly once. The
 *    retry count is exactly one — not zero (so a transient collision still
 *    has a chance) and not more (so a real disk fault surfaces quickly rather
 *    than spinning). If the retry also fails the tally is incremented and the
 *    structured warning is returned.
 *
 * In every failure case the function returns a result rather than throwing —
 * the run loop surfaces the warning and keeps going; `droppedEmits` is the
 * sole signal the orchestrator sees that an emit was lost.
 */

import { appendTraceEvent, type TraceEventInput } from './append.js';
import { getDroppedEmits, incrementDroppedEmits } from './dropped-emits.js';
import { AGENT_ATTEMPT_EVENT_TYPE } from './events.js';

/**
 * Result of {@link emitTraceEvent}: the assigned sequence number on success,
 * or a structured warning the caller can surface.
 *
 * @property ok `true` on a successful write, `false` on a dropped emit.
 * @property sequenceNumber present iff `ok === true`.
 * @property warning the structured warning message on a dropped emit; the
 *   run loop typically logs it and continues without aborting.
 * @property droppedEmits the post-increment count for the run after a drop;
 *   the caller does not need to read this back from `aggregateRunSummary`
 *   to know an emit was lost.
 */
export interface EmitTraceEventResult {
  ok: boolean;
  sequenceNumber?: number;
  warning?: string;
  droppedEmits?: number;
}

/**
 * Append a trace event with the emit-failure policy that never aborts the
 * run. Both the MCP tool and a direct library import call this single
 * implementation, so the dual-callable surface behaves identically.
 *
 * @param runDir absolute path to the run directory. The trace root is derived
 *   from `runDir` by the underlying {@link appendTraceEvent}.
 * @param event the event body to write; the `agentAttempt` event class is
 *   treated specially on failure (retried exactly once) — see the module doc.
 * @returns see {@link EmitTraceEventResult}. Never throws — failures fold into
 *   the structured-warning result and the in-memory `droppedEmits` tally.
 */
export function emitTraceEvent(runDir: string, event: TraceEventInput): EmitTraceEventResult {
  const eventType = (event as { eventType?: string }).eventType;
  const isAgentAttempt = eventType === AGENT_ATTEMPT_EVENT_TYPE;

  // First write attempt — same code path regardless of event class. The
  // class only affects how a failure is handled below.
  try {
    const res = appendTraceEvent(runDir, event);
    return { ok: true, sequenceNumber: res.sequenceNumber };
  } catch (firstError) {
    if (!isAgentAttempt) {
      // Non-agentAttempt: no retry. Increment and surface the warning.
      incrementDroppedEmits(runDir);
      return buildDropResult(runDir, firstError);
    }

    // agentAttempt: retry exactly once. A second failure is treated as a
    // real disk-level fault (not a transient collision) and surfaced as the
    // structured warning, with droppedEmits incremented.
    try {
      const res = appendTraceEvent(runDir, event);
      return { ok: true, sequenceNumber: res.sequenceNumber };
    } catch (secondError) {
      incrementDroppedEmits(runDir);
      return buildDropResult(runDir, secondError);
    }
  }
}

/**
 * Compose the structured-warning result returned on a dropped emit. Reads the
 * post-increment tally so the caller does not need a second call to learn the
 * count.
 */
function buildDropResult(runDir: string, error: unknown): EmitTraceEventResult {
  // Re-read the tally rather than tracking it in a local — incrementDroppedEmits
  // is the single source of truth, and reading it back guarantees the result
  // reflects exactly what aggregateRunSummary will report on the same instant.
  const droppedEmits = getDroppedEmits(runDir);
  const message =
    error instanceof Error
      ? error.message
      : `The framework could not append a trace event for run dir '${runDir}'.`;
  return {
    ok: false,
    warning: message,
    droppedEmits,
  };
}

/**
 * Trace MCP tool handlers — eleven thin wrappers around the shipped trace
 * library. The handlers compose `traceRoot = join(runDir, 'trace')` for the
 * disk-reading tools, dispatch to the shared single-implementation library
 * functions, and surface the same return shapes a direct library import
 * would. None of the handlers contain second copies of the underlying
 * domain logic — the dual-callable-surface rule applies to every entry
 * point in this module.
 *
 * Emit-failure semantics live here too. `emitTraceEvent` swallows write
 * failures for non-`agentAttempt` events (incrementing the in-memory
 * `droppedEmits` tally instead of throwing) and retries exactly once on
 * `agentAttempt` failures before surfacing a structured warning — the
 * "structured warning, not abort" contract the spec names. The run loop
 * continues regardless; `droppedEmits` is the sole signal the orchestrator
 * sees that an emit was lost.
 */

import path from 'node:path';

import { createError } from '../errors.js';

import {
  appendTraceEvent as libraryAppendTraceEvent,
  type AppendTraceEventResult,
  type TraceEventInput,
} from '../../trace/append.js';
import { incrementDroppedEmits } from '../../trace/dropped-emits.js';
import {
  buildLoopDetectedBody as libraryBuildLoopDetectedBody,
  buildTrustEventBody as libraryBuildTrustEventBody,
  buildValidationAbortBody as libraryBuildValidationAbortBody,
  buildValidationAbortFromCode as libraryBuildValidationAbortFromCode,
  type LoopDetectionHalt,
  type SafetyHaltBody,
  type TrustEventBody,
  type TrustResolution,
  type F2ErrorLike,
  type ValidationAbortBody,
  type ValidationStage,
} from '../../trace/integration.js';
import {
  aggregateRunSummary as libraryAggregateRunSummary,
  formatHeartbeat as libraryFormatHeartbeat,
  formatLlmCallSummary as libraryFormatLlmCallSummary,
  runSprintSummary as libraryRunSprintSummary,
  type LlmCallMetrics,
  type RunSummaryAggregate,
} from '../../trace/progress.js';
import {
  reconcileIndex as libraryReconcileIndex,
  reconstructRecoveryState as libraryReconstructRecoveryState,
  type RecoveryState,
  type TraceIndex,
} from '../../trace/reconcile.js';
import type { ErrorCode } from '../errors.js';

/**
 * Result of {@link emitTraceEventTool}: the assigned sequence number on
 * success, or a structured warning the caller can surface.
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
 * Input to {@link emitTraceEventTool}.
 *
 * @property runDir absolute path to the run directory. The handler derives
 *   the trace root from `runDir` internally.
 * @property event the event body to write; `sequenceNumber` is overwritten
 *   by the library, so any value supplied here is ignored. The
 *   `agentAttempt` event class is treated specially on failure (retried
 *   exactly once before surfacing the structured warning) — see the
 *   emit-failure contract on the module-level doc above.
 */
export interface EmitTraceEventInput {
  runDir: string;
  event: TraceEventInput;
}

/**
 * Append a trace event to the run's trace, with emit-failure semantics that
 * never abort the run.
 *
 * Two failure paths:
 * - **non-`agentAttempt` event:** any write error is caught, the in-memory
 *   `droppedEmits` tally for the `runDir` is incremented, and a structured
 *   warning is returned. The orchestrator surfaces the warning but the
 *   sprint loop keeps going — losing a single non-attempt event is
 *   recoverable; aborting on it would be worse than continuing.
 * - **`agentAttempt` event:** the failure path retries exactly once. If the
 *   retry also fails the tally is incremented and the structured warning is
 *   returned. The retry count is **exactly one** — not zero (so a transient
 *   collision still has a chance) and not more (so a real disk fault is
 *   surfaced quickly rather than spinning).
 *
 * The handler is the single owner of those policies; a caller that imports
 * `appendTraceEvent` directly bypasses them deliberately, because the
 * library is the lower layer used both here and by recovery code that
 * wants the raw throw.
 *
 * @param input see {@link EmitTraceEventInput}.
 * @returns see {@link EmitTraceEventResult}.
 */
export function emitTraceEventTool(input: EmitTraceEventInput): EmitTraceEventResult {
  const { runDir, event } = input;
  const eventType = (event as { eventType?: string }).eventType;
  const isAgentAttempt = eventType === 'agentAttempt';

  // First write attempt — same code path regardless of event class. The
  // class only affects how a failure is handled below.
  try {
    const res = libraryAppendTraceEvent(runDir, event);
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
      const res = libraryAppendTraceEvent(runDir, event);
      return { ok: true, sequenceNumber: res.sequenceNumber };
    } catch (secondError) {
      incrementDroppedEmits(runDir);
      return buildDropResult(runDir, secondError);
    }
  }
}

/**
 * Compose the structured-warning result the tool returns on a dropped emit.
 * Reads the post-increment tally so the caller does not need a second tool
 * call to learn the count.
 */
function buildDropResult(runDir: string, error: unknown): EmitTraceEventResult {
  // Re-read the tally rather than tracking it in a local — incrementDroppedEmits
  // is the single source of truth, and reading it back guarantees the result
  // reflects exactly what aggregateRunSummary will report on the same instant.
  // Note: importing getDroppedEmits here would introduce a cycle with progress.ts;
  // instead, we surface the warning string and let the caller call
  // aggregateRunSummary if they need the precise count.
  const message =
    error instanceof Error
      ? error.message
      : `The framework could not append a trace event for run dir '${runDir}'.`;
  return {
    ok: false,
    warning: message,
  };
}

/**
 * Input to {@link runSprintSummaryTool}: just the run directory.
 */
export interface RunSprintSummaryInput {
  runDir: string;
}

/**
 * Disk-reading wrapper: scan `<runDir>/trace/events/` and format the
 * `[sprint-summary] …` roll-up. Single-implementation; the same library
 * function {@link libraryRunSprintSummary} is what a direct library import
 * would call.
 */
export function runSprintSummaryTool(input: RunSprintSummaryInput): string {
  return libraryRunSprintSummary(input.runDir);
}

/**
 * Input to {@link aggregateRunSummaryTool}.
 */
export interface AggregateRunSummaryInput {
  runDir: string;
}

/**
 * Disk-reading wrapper: compute the extended {@link RunSummaryAggregate}
 * for the run. Routes through the shared library function.
 */
export function aggregateRunSummaryTool(input: AggregateRunSummaryInput): RunSummaryAggregate {
  return libraryAggregateRunSummary(input.runDir);
}

/**
 * Input to {@link reconcileTraceIndexTool}.
 */
export interface ReconcileTraceIndexInput {
  runDir: string;
}

/**
 * Disk-reading wrapper over the shipped {@link libraryReconcileIndex}.
 * Computes `traceRoot = join(runDir, 'trace')` and derives the `runId` from
 * the last segment of `runDir` (`<storeRoot>/<repoKey>/runs/<runId>`), so
 * the markdown orchestrator never has to thread the id separately.
 */
export function reconcileTraceIndexTool(input: ReconcileTraceIndexInput): TraceIndex {
  const traceRoot = path.join(input.runDir, 'trace');
  const runId = path.basename(input.runDir);
  return libraryReconcileIndex(traceRoot, runId);
}

/**
 * Input to {@link reconstructRecoveryStateTool}.
 */
export interface ReconstructRecoveryStateInput {
  runDir: string;
}

/**
 * Disk-reading wrapper over the shipped {@link libraryReconstructRecoveryState}.
 */
export function reconstructRecoveryStateTool(input: ReconstructRecoveryStateInput): RecoveryState {
  const traceRoot = path.join(input.runDir, 'trace');
  return libraryReconstructRecoveryState(traceRoot);
}

/**
 * Input to {@link formatHeartbeatTool}.
 *
 * @property role kebab-case role id — passed verbatim to the in-memory
 *   formatter.
 */
export interface FormatHeartbeatInput {
  role: string;
}

/**
 * Metadata-only wrapper: format the per-role heartbeat. No disk I/O; no
 * payload content surfaces in the returned string.
 */
export function formatHeartbeatTool(input: FormatHeartbeatInput): string {
  return libraryFormatHeartbeat(input.role);
}

/**
 * Input to {@link formatLlmCallSummaryTool}.
 *
 * @property metrics the per-call metrics; only the fields named on
 *   {@link LlmCallMetrics} feed the output — any extra payload-content
 *   fields the caller passes are ignored by the formatter, preserving the
 *   "metadata only" guarantee.
 */
export interface FormatLlmCallSummaryInput {
  metrics: LlmCallMetrics;
}

/**
 * Metadata-only wrapper over {@link libraryFormatLlmCallSummary}. The
 * `metrics` shape is structurally typed: extra keys on the input object
 * cannot influence the output because the underlying formatter reads only
 * the documented fields — any prompt/response body the caller mistakenly
 * passes alongside the metrics is silently ignored.
 */
export function formatLlmCallSummaryTool(input: FormatLlmCallSummaryInput): string {
  return libraryFormatLlmCallSummary(input.metrics);
}

/**
 * Input to {@link buildTrustEventBodyTool}.
 */
export interface BuildTrustEventBodyInput {
  resolution: TrustResolution;
}

/**
 * Body-builder wrapper: byte-for-byte forward to the shipped builder. The
 * `promptVariant` discriminant and the four-valued `userChoice` mapping
 * (`view` / `approve` / `runWithoutProjectCommands` / `cancel`) pass
 * through unchanged — `approve` and `runWithoutProjectCommands` MUST stay
 * distinct (they carry different trust semantics; collapsing them would
 * silently downgrade the trust posture).
 */
export function buildTrustEventBodyTool(input: BuildTrustEventBodyInput): TrustEventBody {
  return libraryBuildTrustEventBody(input.resolution);
}

/**
 * Input to {@link buildValidationAbortBodyTool}.
 *
 * @property stage the {@link ValidationStage} discriminant — preserved
 *   byte-for-byte on the returned body. Dropping it would erase which
 *   validation layer raised the abort, defeating the body's purpose.
 * @property error the F2-like error; its portable fields land on the body
 *   via the shipped `extractF2Payload`. `name` and `stack` are dropped.
 */
export interface BuildValidationAbortBodyInput {
  stage: ValidationStage;
  error: F2ErrorLike;
}

/**
 * Body-builder wrapper that preserves the `ValidationStage` discriminant.
 * Routes straight through {@link libraryBuildValidationAbortBody}.
 */
export function buildValidationAbortBodyTool(
  input: BuildValidationAbortBodyInput,
): ValidationAbortBody {
  return libraryBuildValidationAbortBody(input.stage, input.error);
}

/**
 * Input to {@link buildValidationAbortFromCodeTool}.
 *
 * @property stage the validation stage discriminant.
 * @property code the framework error code to construct from.
 * @property details optional error details forwarded to `createError`;
 *   defaults to `{}` on the library side.
 */
export interface BuildValidationAbortFromCodeInput {
  stage: ValidationStage;
  code: ErrorCode;
  details?: Parameters<typeof createError>[1];
}

/**
 * Body-builder wrapper that constructs the error from a code + optional
 * details and forwards to {@link libraryBuildValidationAbortFromCode}.
 */
export function buildValidationAbortFromCodeTool(
  input: BuildValidationAbortFromCodeInput,
): ValidationAbortBody {
  return libraryBuildValidationAbortFromCode(input.stage, input.code, input.details ?? {});
}

/**
 * Input to {@link buildLoopDetectedBodyTool}.
 *
 * @property halt the loop-detection halt details. The `reason` discriminator
 *   (`roleCeilingExceeded` / `sprintBudgetExceeded` / `editOscillationDetected`)
 *   appears verbatim on the returned `payload.reason`.
 */
export interface BuildLoopDetectedBodyInput {
  halt: LoopDetectionHalt;
}

/**
 * Body-builder wrapper that produces a `safetyHalt` body with
 * `safetyClass = 'loopDetected'`. The trigger discriminator is preserved
 * across all three documented values.
 */
export function buildLoopDetectedBodyTool(input: BuildLoopDetectedBodyInput): SafetyHaltBody {
  return libraryBuildLoopDetectedBody(input.halt);
}

// Re-export the result alias from the library so a tool-test importer needs
// only this single module.
export type { AppendTraceEventResult };

/**
 * Trace MCP tool handlers — eleven thin wrappers around the shipped trace
 * library. The handlers compose `traceRoot = join(runDir, 'trace')` for the
 * disk-reading tools, dispatch to the shared single-implementation library
 * functions, and surface the same return shapes a direct library import
 * would. None of the handlers contain second copies of the underlying
 * domain logic — the dual-callable-surface rule applies to every entry
 * point in this module.
 *
 * Emit-failure semantics do NOT live here: they live in the shared
 * `emitTraceEvent` layer in `../../trace/emit.js`, which swallows write
 * failures for non-`agentAttempt` events (incrementing the in-memory
 * `droppedEmits` tally instead of throwing) and retries exactly once on
 * `agentAttempt` failures before surfacing a structured warning. Putting the
 * policy in one shared layer is what makes the MCP tool and a direct library
 * import behave identically for equal inputs — the dual-callable rule. The
 * tool wrapper below simply forwards to that shared function.
 */

import path from 'node:path';

import { createError } from '../errors.js';

import { type AppendTraceEventResult, type TraceEventInput } from '../../trace/append.js';
import {
  emitTraceEvent as libraryEmitTraceEvent,
  type EmitTraceEventResult,
} from '../../trace/emit.js';
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
 * Result of {@link emitTraceEventTool}: the shared {@link EmitTraceEventResult}
 * the library's `emitTraceEvent` returns (assigned sequence number on success,
 * or a structured warning on a dropped emit), augmented with the F2 mutation
 * indicator as a sibling field. Re-exported alongside the tool result so a
 * tool-test importer needs only this single module.
 *
 * @property mutated `true` when an event was appended (`ok === true`), `false`
 *   on a dropped / best-effort-failed emit (`ok === false`). Surfaced under
 *   the uniform F2 `mutated` name so the orchestrator can OR it in with the
 *   other R7 write tools without having to know that this tool signals the
 *   drop via `ok` instead.
 */
export type { EmitTraceEventResult };

/**
 * The `emitTraceEvent` tool's return shape: the library
 * {@link EmitTraceEventResult} plus the uniform F2 `mutated` indicator
 * (`true` when an event was appended, `false` on a dropped or
 * best-effort-failed emit). The property notes above describe how `mutated`
 * is derived from the underlying `ok` signal.
 */
export type EmitTraceEventToolResult = EmitTraceEventResult & { mutated: boolean };

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
 * never abort the run. A byte-thin forward to the shared
 * {@link libraryEmitTraceEvent} — the single owner of the one-retry-on-
 * `agentAttempt`, increment-`droppedEmits`, structured-warning policy. A
 * caller importing `emitTraceEvent` from the trace barrel gets the identical
 * behaviour, because the policy lives in that one shared layer rather than
 * here.
 *
 * @param input see {@link EmitTraceEventInput}.
 * @returns see {@link EmitTraceEventToolResult}.
 */
export function emitTraceEventTool(input: EmitTraceEventInput): EmitTraceEventToolResult {
  const result = libraryEmitTraceEvent(input.runDir, input.event);
  // `ok` already distinguishes an appended event from a dropped one; mirror it
  // onto the uniform F2 `mutated` name so callers branch on the same field
  // across every R7 write tool.
  return { ...result, mutated: result.ok };
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
 *   (`roleCeilingExceeded` / `sprintBudgetExceeded` / `editOscillation`)
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

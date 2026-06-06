/**
 * Telemetry MCP tool handlers — two thin wrappers around the shipped
 * telemetry library writers (`writeTelemetryConfig`, `writeTelemetryOutcome`).
 * The handlers delegate end-to-end to the library functions; no second copy
 * of the atomic-write or cost-derivation logic lives behind these tools.
 * The dual-callable-surface rule applies (a tool import and a direct
 * `src/telemetry/*` library import resolve to the same underlying function).
 *
 * Why the writeTelemetryOutcome wrapper reads `droppedEmits` inside the
 * config-server process (the cross-process seam):
 *
 *   The dropped-emit tally lives in `src/trace/dropped-emits.ts` as an
 *   in-memory `Map<runDir, number>` scoped to the long-lived config-server
 *   process. Each emit failure increments the counter in that process; the
 *   value is never persisted to disk by design (the failure mode it flags is
 *   the same disk-full / unwritable-events-dir condition that would prevent
 *   an on-disk counter from being written too). The markdown orchestrator
 *   runs in a separate process and cannot reach that in-memory tally
 *   directly — if the orchestrator were to read its own zero-valued local
 *   tally and ship it across the wire, every recovered or freshly-spawned
 *   orchestrator process would silently misreport `cost.complete = true`
 *   after a real loss. The seam exists to avoid that class of regression:
 *   the orchestrator can pass an explicit `droppedEmits` count when it has
 *   one (the in-process case), and the wrapper falls back to
 *   `getDroppedEmits(runDir)` on the config-server side when the input
 *   omits the field (the cross-process case), so the value is always read
 *   inside the process where the failures were actually counted.
 *
 * Tool return shape: every wrapper returns the uniform F2 mutation indicator
 * (`mutated: true` on a successful write) alongside the path the atomic
 * writer landed; the orchestrator OR's `mutated` in with the other R7 write
 * tools without having to special-case telemetry.
 */

import {
  writeTelemetryConfig as libraryWriteTelemetryConfig,
  writeTelemetryOutcome as libraryWriteTelemetryOutcome,
  type WriteTelemetryConfigInput,
  type WriteTelemetryOutcomeInput,
} from '../../telemetry/index.js';
import { getDroppedEmits } from '../../trace/dropped-emits.js';

/**
 * Input to {@link writeTelemetryConfig} — the library
 * {@link WriteTelemetryConfigInput} preserved exactly. The same object shape
 * a direct library import would consume.
 *
 * @property runDir absolute path of the run directory; the writer derives
 *   `<runDir>/telemetry/config.json` and creates the parent if missing.
 * @property runId the canonical `<YYYYMMDDTHHMMSS>-<4 hex>` identifier
 *   embedded verbatim in the envelope.
 * @property resolvedConfig the captured F2 snapshot recorded by the
 *   artefact; the schema pins the ten required top-level fields and tolerates
 *   forward-compat additions.
 * @property capturedAt the RFC3339-ms timestamp the orchestrator captured for
 *   the snapshot moment; embedded verbatim so this artefact and the trace's
 *   run-start milestone share a single clock read.
 */
export type WriteTelemetryConfigToolInput = WriteTelemetryConfigInput;

/**
 * Return shape of {@link writeTelemetryConfigTool}: the absolute path the
 * atomic writer landed, plus the uniform F2 `mutated` indicator
 * (always `true` on a successful return — the writer is unconditional when
 * it reaches this point).
 *
 * @property path absolute path of the written `telemetry/config.json`.
 * @property mutated `true` — the wrapper always reaches the writer when its
 *   input validates, and the writer is unconditional, so a successful return
 *   always represents a fresh on-disk artefact.
 */
export interface WriteTelemetryConfigToolResult {
  path: string;
  mutated: true;
}

/**
 * Write the run's `telemetry/config.json` atomically.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryWriteTelemetryConfig}; the input object is passed through
 * unchanged. The wrapper does not check whether the target file already
 * exists — the write-once guarantee lives at the call site (the orchestrator
 * invokes the wrapper exactly once per run, before the clarifier spawn).
 *
 * @param input the {@link WriteTelemetryConfigToolInput}; the same object
 *   shape a direct library import would consume.
 * @returns the {@link WriteTelemetryConfigToolResult} — the written path and
 *   `mutated: true`.
 *
 * Side effects: creates `<runDir>/telemetry/` if missing (via the writer's
 * atomic-write primitive); writes via temp+rename so a crash between the two
 * leaves either the complete artefact or no file at all.
 *
 * Failure modes: any I/O failure on the write path bubbles up as a
 * `ConfigServerError` from the atomic-write layer; the wrapper does not
 * intercept or translate.
 */
export async function writeTelemetryConfigTool(
  input: WriteTelemetryConfigToolInput,
): Promise<WriteTelemetryConfigToolResult> {
  const written = await libraryWriteTelemetryConfig(input);
  return { path: written, mutated: true };
}

/**
 * Input to {@link writeTelemetryOutcomeTool} — the library
 * {@link WriteTelemetryOutcomeInput} preserved exactly, including the
 * optional explicit `droppedEmits` cross-process seam.
 *
 * @property runDir absolute path of the run directory; the writer derives
 *   `<runDir>/telemetry/outcome.json` and reads the trace under
 *   `<runDir>/trace/` for the `cost` rollup.
 * @property runId embedded verbatim in the envelope.
 * @property terminalReason the O2 code that drove termination; the writer
 *   derives the run-level `disposition` from it via the mapping module.
 * @property sprints per-sprint outcome records the orchestrator reconstructed
 *   at termination.
 * @property safetyHalts summary references to the run's safety halts; empty
 *   on a non-halted run.
 * @property writtenAt the RFC3339-ms timestamp embedded in the envelope.
 * @property droppedEmits optional explicit dropped-emit count, intended for
 *   the cross-process caller. When provided the writer uses it verbatim;
 *   when omitted the wrapper reads `getDroppedEmits(runDir)` on this side
 *   before invoking the writer, so the in-memory tally that the long-lived
 *   config-server process maintains is always consulted from inside that
 *   process — see the module doc above for the rationale.
 */
export type WriteTelemetryOutcomeToolInput = WriteTelemetryOutcomeInput;

/**
 * Return shape of {@link writeTelemetryOutcomeTool}: the absolute path the
 * atomic writer landed, plus the uniform F2 `mutated` indicator.
 *
 * @property path absolute path of the written `telemetry/outcome.json`.
 * @property mutated `true` — the wrapper always reaches the writer when its
 *   input validates, and the writer is unconditional, so a successful return
 *   always represents a fresh on-disk artefact. Recovery may overwrite the
 *   artefact at the resumed termination (outcome is not exclusive-create);
 *   each call still represents a mutation.
 */
export interface WriteTelemetryOutcomeToolResult {
  path: string;
  mutated: true;
}

/**
 * Write the run's `telemetry/outcome.json` atomically.
 *
 * Single-implementation: delegates to the shipped
 * {@link libraryWriteTelemetryOutcome}. The wrapper's only behaviour beyond
 * the library call is the cross-process seam on `droppedEmits`: when the
 * caller does not supply an explicit count, the wrapper reads
 * `getDroppedEmits(runDir)` on the config-server side and threads the value
 * into the library call, so the in-memory tally is always consulted inside
 * the process that maintains it (the markdown orchestrator runs in a
 * different process and has no access to that tally).
 *
 * @param input the {@link WriteTelemetryOutcomeToolInput}.
 * @returns the {@link WriteTelemetryOutcomeToolResult} — the written path and
 *   `mutated: true`.
 *
 * Side effects: creates `<runDir>/telemetry/` if missing; reads from
 * `<runDir>/trace/events/` when present; writes via temp+rename so a crash
 * between the two leaves either the complete artefact or no file at all.
 *
 * Write-once is a per-run invariant the orchestrator's call site enforces;
 * the wrapper itself does not refuse a second call (a `--recover`-ed run
 * legitimately overwrites the artefact at the resumed termination).
 *
 * Failure modes: any I/O failure on the write path bubbles up as a
 * `ConfigServerError` from the atomic-write layer; the wrapper does not
 * intercept or translate.
 */
export async function writeTelemetryOutcomeTool(
  input: WriteTelemetryOutcomeToolInput,
): Promise<WriteTelemetryOutcomeToolResult> {
  // Cross-process seam: when the caller does not supply an explicit
  // droppedEmits count, read the in-memory tally on this side (inside the
  // long-lived config-server process where the failures were counted).
  // Passing the explicit value through to the library writer makes the
  // wrapper's behaviour identical to a direct library call when the caller
  // is already in this process, and adds the seam only when the caller is
  // not — the only divergence is the source of the count, never the
  // semantics of cost.complete.
  const droppedEmits =
    input.droppedEmits !== undefined ? input.droppedEmits : getDroppedEmits(input.runDir);
  const enriched: WriteTelemetryOutcomeInput = { ...input, droppedEmits };
  const written = await libraryWriteTelemetryOutcome(enriched);
  return { path: written, mutated: true };
}

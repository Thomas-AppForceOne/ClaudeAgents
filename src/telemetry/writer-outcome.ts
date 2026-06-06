/**
 * Atomic writer for the `telemetry/outcome.json` artefact.
 *
 * The writer is the single source of truth for the on-disk shape of
 * outcome.json; the orchestrator's termination step invokes it exactly once
 * per run on every exit path (graceful, halted, aborted, errored) before the
 * run lock releases. It derives the run-level `disposition` from the
 * supplied `terminalReason` via {@link terminalReasonToDisposition} so the
 * mapping table lives in exactly one place, and it derives the `cost`
 * rollup from R7's `aggregateRunSummary` and the in-memory `droppedEmits`
 * tally rather than re-walking the trace itself.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import { getDroppedEmits } from '../trace/dropped-emits.js';
import { aggregateRunSummary } from '../trace/progress.js';
import { terminalReasonToDisposition } from './mapping.js';
import type { Cost, TelemetryOutcomeV1, WriteTelemetryOutcomeInput } from './types.js';

/**
 * Build the v1 outcome envelope and write it atomically to
 * `<runDir>/telemetry/outcome.json`.
 *
 * @param input the {@link WriteTelemetryOutcomeInput} bundle — runDir,
 *   runId, the O2 terminalReason, the per-sprint records, the
 *   safetyHalts[] summary, and the RFC3339-ms timestamp.
 *
 * @returns the absolute path the artefact was written to.
 *
 * Side effects: creates `<runDir>/telemetry/` if missing (via
 * {@link atomicWriteFile}'s recursive mkdir); reads from
 * `<runDir>/trace/events/` when present; writes via temp+rename so a crash
 * between the two leaves either the complete artefact or no file at all.
 *
 * Write-once contract: the writer does not check whether the target file
 * already exists, by design. The write-once guarantee lives at the call site
 * (the orchestrator's termination step runs at most once per run); a
 * re-call would overwrite the artefact, which is the recovery flow's
 * intended behaviour when a `--recover` resumes a previously-interrupted
 * run.
 *
 * Cost derivation:
 * - When `<runDir>/trace/events/` does not exist, `cost` is the literal
 *   JSON null. The trace-unavailable degraded path: O3's contract is that
 *   the summary degrades gracefully rather than failing the write.
 * - When the trace is present, `cost` is a non-null object whose six metric
 *   fields come from {@link aggregateRunSummary} and whose `complete`
 *   discriminator is `getDroppedEmits(runDir) === 0`. Reading the loss
 *   signal from droppedEmits — and not from reconcileTraceIndex — is the
 *   spec's explicit choice: a dropped emit leaves a gapless, fully
 *   index-reconcilable trace, so the reconcile cannot detect the loss. The
 *   only signal that survives the disk-full failure mode this surface
 *   exists to flag is R7's in-memory per-run emit-failure tally.
 *
 * Failure modes: any I/O failure on the write path bubbles up as a
 * ConfigServerError from atomicWriteFile. The cost-derivation path is
 * intentionally fault-tolerant — a missing trace directory yields
 * `cost: null` rather than throwing.
 */
export async function writeTelemetryOutcome(input: WriteTelemetryOutcomeInput): Promise<string> {
  const { runDir, runId, terminalReason, sprints, safetyHalts, writtenAt } = input;
  const disposition = terminalReasonToDisposition(terminalReason);
  const cost = deriveCost(runDir);

  const envelope: TelemetryOutcomeV1 = {
    envelope: {
      schemaVersion: 1,
      writtenAt,
      runId,
    },
    disposition,
    terminalReason,
    sprints,
    cost,
    safetyHalts,
    // Reserved-empty at v1.0. E6 v1.2 will land per-sprint human-review
    // records here as an additive in-place edit per F3's
    // additive-stays-on-vN rule.
    humanReviews: [],
  };

  const serialised = JSON.stringify(envelope, null, 2) + '\n';
  const target = path.join(runDir, 'telemetry', 'outcome.json');
  atomicWriteFile(target, serialised);
  return target;
}

/**
 * Derive the `cost` field for a given run directory.
 *
 * @param runDir absolute path to the run directory. The trace root is the
 *   `<runDir>/trace` subtree; cost is rolled up from `events/` within it.
 *
 * @returns a non-null {@link Cost} when the trace's `events/` directory is
 *   present, or `null` when it is not. The non-null `complete` discriminator
 *   reflects droppedEmits, not reconcileTraceIndex — see the writer's
 *   doc comment for the rationale.
 */
function deriveCost(runDir: string): Cost | null {
  const eventsDirPath = path.join(runDir, 'trace', 'events');
  if (!existsSync(eventsDirPath)) {
    return null;
  }
  const summary = aggregateRunSummary(runDir);
  // droppedEmits === 0 is the verified-complete signal. Reading it through
  // getDroppedEmits directly (rather than through summary.droppedEmits) keeps
  // the dependency edge explicit: outcome.complete derives from R7's
  // in-memory tally, not from anything on disk that a dropped emit could
  // miss.
  const droppedEmits = getDroppedEmits(runDir);
  return {
    complete: droppedEmits === 0,
    tokensInput: summary.tokensInput,
    tokensCached: summary.tokensCached,
    tokensOutput: summary.tokensOutput,
    llmCallCount: summary.calls,
    toolCallCount: summary.toolCalls ?? 0,
    wallClockMs: summary.elapsedMs,
  };
}

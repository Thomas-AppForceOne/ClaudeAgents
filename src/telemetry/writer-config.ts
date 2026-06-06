/**
 * Atomic writer for the `telemetry/config.json` artefact.
 *
 * The writer is the single source of truth for the on-disk shape of
 * config.json; the orchestrator's run-start step invokes it after the
 * resolved-config snapshot is captured and before the clarifier spawns,
 * so the artefact records the framework's view of the project as of
 * run-start (frozen for the rest of the run per O3's snapshot-freshness
 * rule). It is pure I/O: no clock read, no env read, no env writes —
 * every caller-supplied input is embedded verbatim into the envelope,
 * which is what lets the writer be driven by fabricated inputs in tests.
 */

import path from 'node:path';

import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import type { TelemetryConfigV1, WriteTelemetryConfigInput } from './types.js';

/**
 * Build the v1 envelope and write it atomically to
 * `<runDir>/telemetry/config.json`.
 *
 * @param input the {@link WriteTelemetryConfigInput} bundle — runDir, runId,
 *   the captured F2 snapshot, and the RFC3339-ms timestamp. The caller owns
 *   the timestamp so the same run-start moment can be embedded both here and
 *   in the T1 trace's run-start milestone without clock skew.
 *
 * @returns the absolute path the artefact was written to. Returning the path
 *   lets the orchestrator log it on the heartbeat without recomputing the
 *   join itself.
 *
 * Side effects: creates `<runDir>/telemetry/` if missing (via
 * {@link atomicWriteFile}'s recursive mkdir); writes via temp+rename so a
 * crash between the two leaves either the complete artefact or no file at
 * all.
 *
 * Write-once contract: this writer does not check whether the target file
 * already exists, by design. The write-once guarantee lives at the call site
 * (the orchestrator's run-start step runs exactly once per run, before any
 * re-snapshot can be triggered by a `mutated: true` API call), so this
 * function intentionally has no idempotence logic — a re-call would
 * overwrite the artefact.
 *
 * Failure modes: any I/O failure (parent dir uncreatable, temp write fails,
 * rename fails) bubbles up as a ConfigServerError from atomicWriteFile.
 * Inputs are not re-validated against the schema here — the test suite
 * pins the envelope shape against the bundled schema, and the type
 * signature pins the inputs.
 */
export async function writeTelemetryConfig(input: WriteTelemetryConfigInput): Promise<string> {
  const { runDir, runId, resolvedConfig, capturedAt } = input;
  const envelope: TelemetryConfigV1 = {
    envelope: {
      schemaVersion: 1,
      capturedAt,
      runId,
    },
    resolvedConfig,
  };
  // Stable pretty-printed output: a human operator opens this file far
  // more often than a machine, and the consumer side is JSON parsing
  // where indentation is free of cost. The two-space indent matches the
  // rest of the project's JSON artefacts.
  const serialised = JSON.stringify(envelope, null, 2) + '\n';
  const target = path.join(runDir, 'telemetry', 'config.json');
  atomicWriteFile(target, serialised);
  return target;
}

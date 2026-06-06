/**
 * Barrel re-exports for the telemetry module.
 *
 * Consumers (the orchestrator's run-start and run-end steps via the R7
 * MCP-tool wrappers Sprint 2 lands; tests; any future T2 reader) reach the
 * writers, the mapping function, and the v1 types through this single
 * import path so the module's internal file layout is not part of the
 * public surface.
 */

export { terminalReasonToDisposition } from './mapping.js';
export { writeTelemetryConfig } from './writer-config.js';
export { writeTelemetryOutcome } from './writer-outcome.js';
export type {
  Cost,
  Disposition,
  ResolvedConfigSnapshot,
  SafetyHaltEntry,
  SprintEntry,
  SprintStatus,
  TelemetryConfigEnvelope,
  TelemetryConfigV1,
  TelemetryOutcomeEnvelope,
  TelemetryOutcomeV1,
  TerminalReason,
  WriteTelemetryConfigInput,
  WriteTelemetryOutcomeInput,
} from './types.js';

/**
 * T1 — structured run trace, emission library (Sprint 2).
 *
 * Public barrel for the trace-emission surface. The orchestrator/agent path
 * (live wiring is Sprint 3) holds a `TraceEmitter`; downstream readers (A1,
 * O2, T2, V1) consume the reconciliation/classification helpers. Append-only
 * is structural — there is no in-place update/delete on this surface.
 */

export {
  TraceEmitter,
  type TraceEmitterOptions,
  type RedactionMode,
  type LlmCallInput,
  type ToolCallInput,
  type OrchestratorMilestoneInput,
  type AgentAttemptInput,
  type SafetyHaltInput,
  type TrustEventInput,
  type ValidationAbortInput,
  type LlmPayloads,
  type ToolPayloads,
} from './emitter.js';

export {
  computePromptRef,
  computeInputDigest,
  sha256Hex,
  isSha256Hex,
  type LlmRequestIdentity,
  type TraceMessage,
  type TraceToolDefinition,
} from './hash.js';

export {
  buildPayloadFilename,
  buildPayloadRef,
  assertSafeRelativeRef,
  assertRoleId,
  assertPayloadClass,
  padSequence,
  formatTimestamp,
  PAYLOADS_DIRNAME,
  EVENTS_DIRNAME,
  INDEX_FILENAME,
  type PayloadClass,
  type PayloadContentType,
} from './encodings.js';

export {
  scanEvents,
  buildIndex,
  reconcileIndex,
  writeIndex,
  isUnrecoverable,
  safeMergeParsedObject,
  reconstructRecoveryState,
  nextRecoverySequence,
  type TraceIndex,
  type ScanResult,
  type RecoveryState,
  type RoleAttemptState,
} from './reconcile.js';

// ---- Sprint 3: integration-event builders (F3.3, F3.4) ------------------
export {
  buildTrustEventBody,
  buildValidationAbortBody,
  buildValidationAbortFromCode,
  type TrustResolution,
  type TrustEventBody,
  type ValidationAbortBody,
  type ValidationStage,
  type F2ErrorLike,
} from './integration.js';

// ---- Sprint 3: stderr progress-line formatters (F3.5, F3.6, F3.7) -------
export {
  formatHeartbeat,
  formatLlmCallSummary,
  formatWallclock,
  aggregateSprintSummary,
  formatSprintSummary,
  formatSprintSummaryFromEvents,
  type LlmCallMetrics,
  type SprintSummaryAggregate,
} from './progress.js';

// ---- Sprint 3: evidence-bundle verifier (F3.2) --------------------------
export {
  verifyEvidenceBundle,
  checkFailCompleteness,
  type EvidenceBundleVerifyResult,
  type EvidenceBundleFailure,
  type EvidenceBundleCheck,
  type ContractCriterionLike,
  type BundleCriterion,
} from './evidence-bundle.js';

export {
  eventsDir,
  payloadsDir,
  indexPath,
  eventFilename,
  appendEventFile,
  writePayloadFile,
  resolveRefWithinRoot,
} from './store.js';

export type {
  TraceEnvelope,
  TraceEvent,
  OrchestratorMilestoneEvent,
  AgentAttemptEvent,
  LlmCallEvent,
  ToolCallEvent,
  SafetyHaltEvent,
  TrustEventEvent,
  ValidationAbortEvent,
} from './events.js';
export { KNOWN_EVENT_TYPES } from './events.js';

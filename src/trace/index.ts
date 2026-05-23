/**
 * Public barrel for the `trace` subsystem.
 *
 * Re-exports the emitter, content-hashing helpers, filename/ref encodings,
 * scan/reconcile/recovery utilities, the F2-integration body builders, the
 * progress-summary formatters, the evidence-bundle verifier, the low-level
 * store helpers, and the event type definitions. This is the only import
 * surface other subsystems should depend on; the individual modules behind it
 * are implementation detail. Pure re-exports — no runtime behaviour of its own.
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

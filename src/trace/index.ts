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
  type TraceIndex,
  type ScanResult,
} from './reconcile.js';

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

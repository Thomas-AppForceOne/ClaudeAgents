/**
 * Trace event schema — the on-disk shape of every event a run records.
 *
 * Each event extends {@link TraceEnvelope} (the shared header) and pins its
 * own `eventType` literal, making {@link TraceEvent} a discriminated union the
 * reconciler and consumers can narrow by `eventType`. {@link KNOWN_EVENT_TYPES}
 * is the runtime mirror of that union, used to tell a forward-compatible
 * unknown event (a newer framework's event class) apart from a malformed one.
 *
 * Convention worth stating once: payload bodies are never inlined on an event
 * (except the small structured `payload` fields on safety-halt/validation
 * events). Large bodies live in separate payload files and are referenced by
 * the `*Ref` hash fields, keeping the event log compact and append-friendly.
 */

/**
 * Header common to every trace event.
 *
 * @property sequenceNumber strictly-increasing per-run ordinal; the canonical
 *   total order of events (the clock is not authoritative).
 * @property eventType discriminant naming the event class.
 * @property timestamp ISO-8601 UTC instant the event was recorded.
 * @property runId the run this event belongs to.
 */
export interface TraceEnvelope {

  sequenceNumber: number;

  eventType: string;

  timestamp: string;

  runId: string;
}

/**
 * A named orchestrator milestone. `disposition`, when set on a terminal
 * milestone, becomes the run's overall disposition in the index; `summary` is
 * an optional human note. Both are optional.
 */
export interface OrchestratorMilestoneEvent extends TraceEnvelope {
  eventType: 'orchestratorMilestone';
  milestone: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
  summary?: string;
}

/**
 * One agent attempt. `inputDigest` is the hash of the attempt's inputs (the
 * raw inputs are not stored); `outputArtifactPath` points at what it produced;
 * `disposition` records whether it completed, was objected to, or failed.
 */
export interface AgentAttemptEvent extends TraceEnvelope {
  eventType: 'agentAttempt';
  role: string;
  attemptNumber: number;
  inputDigest: string;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
}

/**
 * One LLM call. `promptRef`/`responseRef` are content hashes pointing at the
 * (optionally redacted) bodies; the token counts, latency, and `cacheHit` flag
 * support cost/perf aggregation.
 */
export interface LlmCallEvent extends TraceEnvelope {
  eventType: 'llmCall';
  model: string;
  role: string;
  promptRef: string;
  responseRef: string;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  latencyMs: number;
  cacheHit: boolean;
}

/**
 * One tool call. `argumentsRef`/`resultRef` point at the payload files;
 * `disposition` is the tool's own success/failure.
 */
export interface ToolCallEvent extends TraceEnvelope {
  eventType: 'toolCall';
  tool: string;
  role: string;
  argumentsRef: string;
  resultRef: string;
  disposition: 'completed' | 'failed';
  latencyMs: number;
}

/**
 * A triggered safety halt. The structured `payload` is inlined (not a separate
 * file) because it is small and integral to understanding the halt.
 */
export interface SafetyHaltEvent extends TraceEnvelope {
  eventType: 'safetyHalt';
  safetyClass: string;
  role: string;
  payload: Record<string, unknown>;
}

/**
 * A trust-prompt interaction: which prompt variant was shown, the user's
 * choice, and the config content hash they were prompted about.
 */
export interface TrustEventEvent extends TraceEnvelope {
  eventType: 'trustEvent';
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  contentHash: string;
}

/**
 * A config-validation abort: the stage that rejected, the error code, and the
 * inlined structured error payload.
 */
export interface ValidationAbortEvent extends TraceEnvelope {
  eventType: 'validationAbort';
  validationStage: 'config' | 'overlay' | 'stack' | 'module';
  errorCode: string;
  errorPayload: Record<string, unknown>;
}

/**
 * Discriminated union of every known trace event, narrowable by `eventType`.
 */
export type TraceEvent =
  | OrchestratorMilestoneEvent
  | AgentAttemptEvent
  | LlmCallEvent
  | ToolCallEvent
  | SafetyHaltEvent
  | TrustEventEvent
  | ValidationAbortEvent;

/**
 * Runtime set of the event-type discriminants in {@link TraceEvent}. The
 * scanner uses it to classify an event whose `eventType` it does not recognise
 * as a forward-compatible unknown (skipped with a warning) rather than as
 * corruption — so a trace written by a newer framework version still loads.
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'orchestratorMilestone',
  'agentAttempt',
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
]);

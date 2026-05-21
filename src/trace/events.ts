/**
 * T1 Sprint 2 — TypeScript types for the seven run-trace event classes plus
 * the common envelope (F2.1–F2.4). These mirror `schemas/run-trace-v1.json`:
 * every constructed event validates against `getRunTraceValidator` (asserted
 * in the unit tests), so the types and the schema cannot drift.
 */

/** The common envelope every event carries (F2.1). */
export interface TraceEnvelope {
  /** Monotonic non-negative integer, no gaps within a run. */
  sequenceNumber: number;
  /** Event-class discriminator, camelCase ASCII. */
  eventType: string;
  /** RFC 3339 UTC timestamp, millisecond precision. */
  timestamp: string;
  /** The run identifier. */
  runId: string;
}

/** Sprint-level transition (F2.2). */
export interface OrchestratorMilestoneEvent extends TraceEnvelope {
  eventType: 'orchestratorMilestone';
  milestone: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
  summary?: string;
}

/** One agent invocation (F2.2). */
export interface AgentAttemptEvent extends TraceEnvelope {
  eventType: 'agentAttempt';
  role: string;
  attemptNumber: number;
  inputDigest: string;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
}

/** One LLM API call (F2.3). */
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

/** One tool invocation (F2.4). */
export interface ToolCallEvent extends TraceEnvelope {
  eventType: 'toolCall';
  tool: string;
  role: string;
  argumentsRef: string;
  resultRef: string;
  disposition: 'completed' | 'failed';
  latencyMs: number;
}

/** A safety halt (A1 loop detection; A2 scope violations later). */
export interface SafetyHaltEvent extends TraceEnvelope {
  eventType: 'safetyHalt';
  safetyClass: string;
  role: string;
  payload: Record<string, unknown>;
}

/** An F4 trust-prompt outcome. */
export interface TrustEventEvent extends TraceEnvelope {
  eventType: 'trustEvent';
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  contentHash: string;
}

/** A `validateAll()` failure that aborts the run. */
export interface ValidationAbortEvent extends TraceEnvelope {
  eventType: 'validationAbort';
  validationStage: 'config' | 'overlay' | 'stack' | 'module';
  errorCode: string;
  errorPayload: Record<string, unknown>;
}

/** The discriminated union of all seven v1 event classes. */
export type TraceEvent =
  | OrchestratorMilestoneEvent
  | AgentAttemptEvent
  | LlmCallEvent
  | ToolCallEvent
  | SafetyHaltEvent
  | TrustEventEvent
  | ValidationAbortEvent;

/** The seven v1 known event-class discriminator values. */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'orchestratorMilestone',
  'agentAttempt',
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
]);



export interface TraceEnvelope {

  sequenceNumber: number;

  eventType: string;

  timestamp: string;

  runId: string;
}

export interface OrchestratorMilestoneEvent extends TraceEnvelope {
  eventType: 'orchestratorMilestone';
  milestone: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
  summary?: string;
}

export interface AgentAttemptEvent extends TraceEnvelope {
  eventType: 'agentAttempt';
  role: string;
  attemptNumber: number;
  inputDigest: string;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
}

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

export interface ToolCallEvent extends TraceEnvelope {
  eventType: 'toolCall';
  tool: string;
  role: string;
  argumentsRef: string;
  resultRef: string;
  disposition: 'completed' | 'failed';
  latencyMs: number;
}

export interface SafetyHaltEvent extends TraceEnvelope {
  eventType: 'safetyHalt';
  safetyClass: string;
  role: string;
  payload: Record<string, unknown>;
}

export interface TrustEventEvent extends TraceEnvelope {
  eventType: 'trustEvent';
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  contentHash: string;
}

export interface ValidationAbortEvent extends TraceEnvelope {
  eventType: 'validationAbort';
  validationStage: 'config' | 'overlay' | 'stack' | 'module';
  errorCode: string;
  errorPayload: Record<string, unknown>;
}

export type TraceEvent =
  | OrchestratorMilestoneEvent
  | AgentAttemptEvent
  | LlmCallEvent
  | ToolCallEvent
  | SafetyHaltEvent
  | TrustEventEvent
  | ValidationAbortEvent;

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'orchestratorMilestone',
  'agentAttempt',
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
]);

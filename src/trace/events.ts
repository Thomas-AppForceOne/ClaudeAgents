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
 *
 * `contractRevision` is the active contract revision when the attempt was
 * emitted. It is intentionally optional and additive: a trace written before
 * the field existed (or by a producer that does not stamp it) still validates
 * against the schema, and a missing value is interpreted by downstream readers
 * as revision `0` — the original locked contract. The field exists so a
 * revision-scoped budget accountant can filter attempts by which contract
 * revision they were authored against, without having to rewrite the shipped
 * whole-trace accounting.
 */
export interface AgentAttemptEvent extends TraceEnvelope {
  eventType: 'agentAttempt';
  role: string;
  attemptNumber: number;
  inputDigest: string;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
  contractRevision?: number;
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
 * A single gap the clarifier found while turning a raw prompt into a clarified
 * spec. `class` records how the gap was disposed of — silently resolved with a
 * framework default, defaulted-but-overridable, or surfaced as a blocker — so
 * the trace separates "what we decided for you" from "what we asked about".
 * `round` distinguishes the initial pass from the evolution rounds, letting a
 * reader replay how the spec converged. The structured `payload` is inlined
 * (small and class-specific) rather than referenced by hash.
 */
export interface ClarifierFindingEvent extends TraceEnvelope {
  eventType: 'clarifierFinding';
  class: 'selfResolved' | 'assumption' | 'blocker';
  gapClass: string;
  round: number;
  payload: Record<string, unknown>;
}

/**
 * One user interaction at the clarifier's draft-preview menu. `action` captures
 * the choice, including the timeout fallthrough, so an unattended run's outcome
 * is as auditable as an interactive one. `round` ties the action to the round
 * it terminated. The inlined `payload` carries the choice's detail (e.g. the
 * verbatim evolution text) and is empty for choices that need none.
 */
export interface ClarifierUserActionEvent extends TraceEnvelope {
  eventType: 'clarifierUserAction';
  action: 'approved' | 'edited' | 'evolved' | 'cancelled' | 'autoApprovedOnTimeout';
  round: number;
  payload: Record<string, unknown>;
}

/**
 * Independent-review trace marker: one event per generator attempt the
 * contract-free reviewer role inspected. The payload is a lightweight
 * summary; the reviewer's full per-finding bundle lives in the sibling
 * `sprint-{N}-independent-review-{attempt}.json` artefact. The marker exists
 * so a trace reader can locate "a review happened" without opening the
 * artefact file, and so the run trace surfaces the v1.0 headline role.
 *
 * Deliberately distinct from {@link AgentAttemptEvent}: the reviewer is
 * off-budget — emitting an `agentAttempt` here would mis-fire the
 * sprint-budget guard against a role that does not bear attempts.
 *
 * The reviewer's cost is still visible: the reviewer's `llmCall` event is
 * emitted normally, so `aggregateSprintSummary` sums its tokens like any
 * other role's. Only the budget-bearing `agentAttempt` is withheld.
 */
export interface IndependentReviewEvent extends TraceEnvelope {
  eventType: 'independentReview';
  payload: {

    sprintNumber: number;

    attemptLetter: string;

    contractRevision: number;

    verdict: 'clean' | 'findings';
    summary: {
      blockers: number;
      warnings: number;
      advisories: number;
      dropped: number;
    };
  };
}

/**
 * The `eventType` discriminant for {@link AgentAttemptEvent}, named so the
 * special handling the emit path gives this class (the one-retry-on-failure
 * policy) keys off a single shared identifier rather than a bare string
 * literal. A rename of the class then surfaces at every site that compares
 * against it instead of silently leaving a stale copy behind.
 */
export const AGENT_ATTEMPT_EVENT_TYPE = 'agentAttempt';

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
  | ValidationAbortEvent
  | ClarifierFindingEvent
  | ClarifierUserActionEvent
  | IndependentReviewEvent;

/**
 * Runtime set of the event-type discriminants in {@link TraceEvent}. The
 * scanner uses it to classify an event whose `eventType` it does not recognise
 * as a forward-compatible unknown (skipped with a warning) rather than as
 * corruption — so a trace written by a newer framework version still loads.
 *
 * Three-place wiring: every entry here must also (a) have a matching
 * `definitions/<name>` event class in `schemas/run-trace-v1.json` and (b) be a
 * discriminant value the {@link TraceEvent} union narrows on. A class added
 * only to the schema or only to the union is silently dropped by the shipped
 * scanner as a forward-compatible unknown; the test
 * `tests/trace/independent-review-event-three-place-wiring.test.ts` enforces
 * the three places agree.
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'orchestratorMilestone',
  AGENT_ATTEMPT_EVENT_TYPE,
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
  'clarifierFinding',
  'clarifierUserAction',
  'independentReview',
]);

/**
 * TraceEmitter — the single append point for a run's audit trace.
 *
 * Every observable moment of a `/gan` run (LLM calls, tool calls, agent
 * attempts, milestones, safety halts, trust prompts, validation aborts) is
 * recorded here as an immutable, sequence-numbered event. The emitter owns
 * three pieces of state that must stay mutually consistent: a monotonic
 * sequence counter, the on-disk event log, and the rolling index summary.
 *
 * Two invariants hold across every `emit*` method and are stated once here
 * rather than repeated per method:
 *
 * 1. Sequence numbers are allocated strictly monotonically (one per event,
 *    never reused) so events totally order even when timestamps collide; the
 *    counter is the source of truth, the clock is not.
 * 2. Persistence is event-file-then-index: {@link TraceEmitter.persist} writes
 *    the event file, folds it into the in-memory index, then rewrites the
 *    index. The index is therefore a derived summary that can always be
 *    rebuilt from the event files via {@link TraceEmitter.reconcile} after a
 *    crash — the event log is authoritative, the index is a cache.
 *
 * Redaction is decided once at construction: in `'hashed'` mode no payload
 * bodies are written to disk (only their content-hash refs land on the
 * event), so a trace can be retained without storing prompt/response text.
 */

import { createError } from '../config-server/errors.js';
import { buildPayloadRef, formatTimestamp, type PayloadContentType } from './encodings.js';
import {
  computeInputDigest,
  computePromptRef,
  sha256Hex,
  type LlmRequestIdentity,
} from './hash.js';
import type {
  AgentAttemptEvent,
  ClarifierFindingEvent,
  ClarifierUserActionEvent,
  IndependentReviewEvent,
  LlmCallEvent,
  OrchestratorMilestoneEvent,
  SafetyHaltEvent,
  ToolCallEvent,
  TraceEvent,
  TrustEventEvent,
  ValidationAbortEvent,
} from './events.js';
import { appendEventFile, writePayloadFile } from './store.js';
import {
  buildIndex,
  reconcileIndex,
  scanEvents,
  writeIndex,
  type TraceIndex,
} from './reconcile.js';

/**
 * Whether payload bodies are persisted (`'full'`) or only their content hashes
 * are recorded while bodies are dropped (`'hashed'`). Chosen once at emitter
 * construction and fixed for the run's lifetime.
 */
export type RedactionMode = 'full' | 'hashed';

/**
 * Construction options for {@link TraceEmitter}.
 *
 * @property traceRoot absolute directory under which `events/`, `payloads/`,
 *   and `index.json` live; the emitter scans it on construction to recover any
 *   pre-existing index state.
 * @property runId stamped onto every emitted event's envelope and onto the
 *   index, tying all events of one run together.
 * @property redaction redaction policy; defaults to `'full'` (bodies written).
 * @property startSequence first sequence number to allocate; defaults to `0`.
 *   Must be a non-negative integer or the constructor throws — used on
 *   recovery to continue numbering past already-persisted events.
 */
export interface TraceEmitterOptions {

  traceRoot: string;

  runId: string;

  redaction?: RedactionMode;

  startSequence?: number;
}

/**
 * Prompt/response text for an LLM-call event. Stored verbatim as `text`
 * payloads in `'full'` redaction mode; ignored on disk in `'hashed'` mode.
 */
export interface LlmPayloads {

  prompt: string;

  response: string;
}

/**
 * Argument/result payloads for a tool-call event. Each may be a raw string
 * (recorded as `text`) or a JSON-shaped value (pretty-printed and recorded as
 * `structured`); see {@link serialisePayload}.
 */
export interface ToolPayloads {

  arguments: string | Record<string, unknown> | unknown[];

  result: string | Record<string, unknown> | unknown[];
}

/**
 * Input to {@link TraceEmitter.emitLlmCall}.
 *
 * @property role kebab-case agent role making the call (e.g. `gan-generator`).
 * @property request the full request identity hashed into a deterministic
 *   `promptRef`; identical requests yield identical refs (cache-key discipline).
 * @property payloads prompt/response text persisted only in `'full'` mode.
 * @property tokensInput / tokensCached / tokensOutput token accounting copied
 *   onto the event for later aggregation.
 * @property latencyMs wall-clock duration of the call in milliseconds.
 * @property cacheHit whether the provider served this from prompt cache.
 */
export interface LlmCallInput {
  role: string;

  request: LlmRequestIdentity;

  payloads: LlmPayloads;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  latencyMs: number;
  cacheHit: boolean;
}

/**
 * Input to {@link TraceEmitter.emitToolCall}.
 *
 * @property tool the tool's name.
 * @property role agent role that invoked it.
 * @property payloads arguments + result, serialised per {@link serialisePayload}.
 * @property disposition `'completed'` or `'failed'`; the tool's own outcome,
 *   not the emit's.
 * @property latencyMs wall-clock duration in milliseconds.
 */
export interface ToolCallInput {
  tool: string;
  role: string;
  payloads: ToolPayloads;
  disposition: 'completed' | 'failed';
  latencyMs: number;
}

/**
 * Input to {@link TraceEmitter.emitOrchestratorMilestone}.
 *
 * @property milestone the milestone's name/identifier.
 * @property disposition optional terminal outcome; when present and the
 *   milestone is recorded, it becomes the run's `index.disposition`.
 * @property summary optional human-readable note.
 */
export interface OrchestratorMilestoneInput {
  milestone: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
  summary?: string;
}

/**
 * Input to {@link TraceEmitter.emitAgentAttempt}.
 *
 * @property role agent role attempting the work.
 * @property attemptNumber 1-based attempt counter for this role.
 * @property inputs arbitrary attempt inputs; hashed to an `inputDigest` (the
 *   raw inputs are not stored, only their digest) so retries with identical
 *   inputs are detectable.
 * @property outputArtifactPath path to the artifact this attempt produced.
 * @property disposition `'completed'`, `'objected'`, or `'failed'`.
 */
export interface AgentAttemptInput {
  role: string;
  attemptNumber: number;

  inputs: unknown;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
}

/**
 * Input to {@link TraceEmitter.emitSafetyHalt}.
 *
 * @property safetyClass classification of the triggered safety rule.
 * @property role role whose action tripped it.
 * @property payload structured detail about the halt, recorded verbatim.
 */
export interface SafetyHaltInput {
  safetyClass: string;
  role: string;
  payload: Record<string, unknown>;
}

/**
 * Input to {@link TraceEmitter.emitTrustEvent}.
 *
 * @property promptVariant which trust prompt was shown — a first introduction
 *   or a re-prompt after the config content changed.
 * @property userChoice the user's response to the prompt.
 * @property contentHash the config content hash the user was prompted about.
 */
export interface TrustEventInput {
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  contentHash: string;
}

/**
 * Input to {@link TraceEmitter.emitValidationAbort}.
 *
 * @property validationStage which layer rejected the config.
 * @property errorCode the framework error code that caused the abort.
 * @property errorPayload structured error detail, recorded verbatim.
 */
export interface ValidationAbortInput {
  validationStage: 'config' | 'overlay' | 'stack' | 'module';
  errorCode: string;
  errorPayload: Record<string, unknown>;
}

/**
 * Input to {@link TraceEmitter.emitClarifierFinding}.
 *
 * @property class how the gap was disposed of — silently resolved with a
 *   default, defaulted-but-overridable, or surfaced as a blocker.
 * @property gapClass catalog label for the kind of ambiguity (snake_case, e.g.
 *   `scope_ambiguity`).
 * @property round clarification round that detected the gap (1 initial, 2-3
 *   evolution); lets a reader attribute the finding to a round.
 * @property payload class-specific detail recorded verbatim (shape varies by
 *   `class`, so it is left open).
 */
export interface ClarifierFindingInput {
  class: 'selfResolved' | 'assumption' | 'blocker';
  gapClass: string;
  round: number;
  payload: Record<string, unknown>;
}

/**
 * Input to {@link TraceEmitter.emitClarifierUserAction}.
 *
 * @property action the user's draft-preview choice, including the
 *   timeout-driven auto-approval so an unattended run stays auditable.
 * @property round round the interaction terminated; correlates with the
 *   round's findings.
 * @property payload action-specific detail recorded verbatim (e.g. the
 *   evolution text), empty for choices that carry none.
 */
export interface ClarifierUserActionInput {
  action: 'approved' | 'edited' | 'evolved' | 'cancelled' | 'autoApprovedOnTimeout';
  round: number;
  payload: Record<string, unknown>;
}

/**
 * Input to {@link TraceEmitter.emitIndependentReview}.
 *
 * The fields mirror the `independentReview` event's `payload` shape one-to-one
 * because the inlined payload is small and integral — same precedent as
 * {@link SafetyHaltInput}. Callers construct the summary object themselves so
 * the emitter has no opinion about how findings are counted; the schema
 * enforces the non-negative-integer floor.
 *
 * @property sprintNumber sprint this review belongs to; positive integer.
 * @property attemptLetter single uppercase ASCII letter naming the generator
 *   attempt this review covered ('A' for the first, 'B' for the second, ...);
 *   joins the event to the sibling `sprint-{N}-independent-review-{A}.json`
 *   artefact filename without ambiguity.
 * @property contractRevision active contract revision when the review ran;
 *   non-negative integer matching {@link AgentAttemptInput}'s convention so
 *   revision-scoped queries treat the two classes consistently.
 * @property verdict 'clean' when zero surviving findings; 'findings' when at
 *   least one finding survived the false-positive guard.
 * @property summary per-tier finding counts plus the dropped-by-the-guard
 *   count; all four values are non-negative integers.
 */
export interface IndependentReviewInput {
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
}

/**
 * Normalise a tool payload into a `{ content, contentType }` pair. A string is
 * stored as-is and tagged `text`; any other JSON-shaped value is pretty-printed
 * (2-space indent) with a trailing newline and tagged `structured`. The
 * trailing newline keeps the on-disk payload POSIX-text-clean and stable for
 * line-based diffing.
 */
function serialisePayload(value: string | Record<string, unknown> | unknown[]): {
  content: string;
  contentType: PayloadContentType;
} {
  if (typeof value === 'string') {
    return { content: value, contentType: 'text' };
  }
  return { content: JSON.stringify(value, null, 2) + '\n', contentType: 'structured' };
}

/**
 * Append-only emitter for one run's trace. Construct once per run; call the
 * `emit*` methods as events occur. Each emit allocates a sequence number,
 * persists the event (and, in `'full'` mode, its payload bodies), and updates
 * the index. See the module block for the monotonic-sequence and
 * event-then-index invariants.
 */
export class TraceEmitter {
  private readonly traceRoot: string;
  private readonly runId: string;
  private readonly redaction: RedactionMode;
  private nextSequence: number;

  private index: TraceIndex;

  // Injectable clock (epoch ms). Defaults to Date.now but is overridable so
  // tests get deterministic timestamps without mocking globals.
  private readonly now: () => number;

  /**
   * @param options see {@link TraceEmitterOptions}.
   * @param clock epoch-millisecond clock; defaults to `Date.now`. Injected for
   *   deterministic timestamps in tests.
   * @throws `MalformedInput` when `options.startSequence` is present but not a
   *   non-negative integer.
   *
   * Side effect: scans `traceRoot` for any already-persisted events and seeds
   * the in-memory index from them, so an emitter constructed over an existing
   * trace continues that trace rather than clobbering its summary.
   */
  constructor(options: TraceEmitterOptions, clock: () => number = () => Date.now()) {
    this.traceRoot = options.traceRoot;
    this.runId = options.runId;
    this.redaction = options.redaction ?? 'full';
    const start = options.startSequence ?? 0;
    if (!Number.isInteger(start) || start < 0) {
      throw createError('MalformedInput', {
        message: 'The framework requires a non-negative integer start sequence for the trace.',
        field: 'startSequence',
      });
    }
    this.nextSequence = start;
    this.now = clock;

    const scan = scanEvents(this.traceRoot);
    this.index = buildIndex(this.runId, scan.events, scan.unknownClassEvents);
  }

  /** The redaction mode fixed at construction. */
  getRedactionMode(): RedactionMode {
    return this.redaction;
  }

  /**
   * The sequence number the next emit will allocate, without consuming it.
   * Read-only probe (e.g. for tests/recovery); does not advance the counter.
   */
  peekNextSequence(): number {
    return this.nextSequence;
  }

  // Consume and return the next sequence number, advancing the counter. The
  // sole place the counter moves, which keeps allocation monotonic and gap-free.
  private allocateSequence(): number {
    const seq = this.nextSequence;
    this.nextSequence = seq + 1;
    return seq;
  }

  // Build the common envelope fields shared by every event: a freshly
  // allocated sequence number, the literal event type, an ISO timestamp from
  // the injected clock, and the run id. Each emit spreads this then adds its
  // own fields.
  private envelope<T extends string>(
    eventType: T,
  ): { sequenceNumber: number; eventType: T; timestamp: string; runId: string } {
    const sequenceNumber = this.allocateSequence();
    return {
      sequenceNumber,
      eventType,
      timestamp: formatTimestamp(this.now()),
      runId: this.runId,
    };
  }

  /**
   * Record an orchestrator milestone. Returns the persisted event (sequence
   * number and timestamp filled in). Side effect: appends an event file and
   * rewrites the index; when `input.disposition` is set it becomes the run's
   * recorded disposition. Optional fields are written only when present, so
   * the event JSON never carries `undefined` keys.
   */
  emitOrchestratorMilestone(input: OrchestratorMilestoneInput): OrchestratorMilestoneEvent {
    const event: OrchestratorMilestoneEvent = {
      ...this.envelope('orchestratorMilestone'),
      milestone: input.milestone,
    };
    if (input.disposition !== undefined) event.disposition = input.disposition;
    if (input.summary !== undefined) event.summary = input.summary;
    this.persist(event);
    return event;
  }

  /**
   * Record an agent attempt. The raw `input.inputs` are hashed to an
   * `inputDigest` and discarded — only the digest is persisted. Returns the
   * persisted event. Side effect: appends an event file and rewrites the index.
   */
  emitAgentAttempt(input: AgentAttemptInput): AgentAttemptEvent {
    const event: AgentAttemptEvent = {
      ...this.envelope('agentAttempt'),
      role: input.role,
      attemptNumber: input.attemptNumber,
      inputDigest: computeInputDigest(input.inputs),
      outputArtifactPath: input.outputArtifactPath,
      disposition: input.disposition,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record an LLM call. The event always carries a deterministic `promptRef`
   * (hash of the request identity) and a `responseRef` (hash of the response
   * body), so two byte-identical calls produce identical refs regardless of
   * redaction mode. Returns the persisted event.
   *
   * Side effects: in `'full'` mode, writes the prompt and response bodies as
   * `text` payload files; in `'hashed'` mode no bodies are written (only the
   * refs survive). Always appends the event file and rewrites the index.
   */
  emitLlmCall(input: LlmCallInput): LlmCallEvent {
    const envelope = this.envelope('llmCall');
    const promptRef = computePromptRef(input.request);
    const responseRef = sha256Hex(input.payloads.response);

    // Body persistence is gated on redaction; the refs above are always
    // recorded so the event stays verifiable even when bodies are dropped.
    if (this.redaction === 'full') {
      this.storePayload(
        envelope.sequenceNumber,
        input.role,
        'prompt',
        input.payloads.prompt,
        'text',
      );
      this.storePayload(
        envelope.sequenceNumber,
        input.role,
        'response',
        input.payloads.response,
        'text',
      );
    }

    const event: LlmCallEvent = {
      ...envelope,
      model: input.request.model,
      role: input.role,
      promptRef,
      responseRef,
      tokensInput: input.tokensInput,
      tokensCached: input.tokensCached,
      tokensOutput: input.tokensOutput,
      latencyMs: input.latencyMs,
      cacheHit: input.cacheHit,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record a tool call. Argument and result payloads are serialised (string →
   * text, otherwise pretty-printed JSON) and their refs computed up front so
   * the event references a deterministic filename. Returns the persisted event.
   *
   * Side effects: in `'full'` mode writes the arguments and result payload
   * files; in `'hashed'` mode no bodies are written but the refs are still
   * recorded. Always appends the event file and rewrites the index.
   */
  emitToolCall(input: ToolCallInput): ToolCallEvent {
    const envelope = this.envelope('toolCall');
    const args = serialisePayload(input.payloads.arguments);
    const res = serialisePayload(input.payloads.result);

    // Refs are derived from sequence/role/class/content-type, so they are
    // computed regardless of redaction — the event always points at where the
    // body would live, even when the body is not written.
    const argumentsRef = buildPayloadRef(
      envelope.sequenceNumber,
      input.role,
      'arguments',
      args.contentType,
    );
    const resultRef = buildPayloadRef(
      envelope.sequenceNumber,
      input.role,
      'result',
      res.contentType,
    );

    if (this.redaction === 'full') {
      writePayloadFile(this.traceRoot, argumentsRef, args.content);
      writePayloadFile(this.traceRoot, resultRef, res.content);
    }

    const event: ToolCallEvent = {
      ...envelope,
      tool: input.tool,
      role: input.role,
      argumentsRef,
      resultRef,
      disposition: input.disposition,
      latencyMs: input.latencyMs,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record a safety-halt event with its classification and structured payload.
   * Returns the persisted event. Side effect: appends an event file and
   * rewrites the index. No payload bodies are written separately — the inline
   * `payload` is part of the event itself.
   */
  emitSafetyHalt(input: SafetyHaltInput): SafetyHaltEvent {
    const event: SafetyHaltEvent = {
      ...this.envelope('safetyHalt'),
      safetyClass: input.safetyClass,
      role: input.role,
      payload: input.payload,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record a trust-prompt event (which prompt variant was shown, the user's
   * choice, and the content hash in question). Returns the persisted event.
   * Side effect: appends an event file and rewrites the index.
   */
  emitTrustEvent(input: TrustEventInput): TrustEventEvent {
    const event: TrustEventEvent = {
      ...this.envelope('trustEvent'),
      promptVariant: input.promptVariant,
      userChoice: input.userChoice,
      contentHash: input.contentHash,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record a validation-abort event (the stage that rejected the config plus
   * the error code and payload). Returns the persisted event. Side effect:
   * appends an event file and rewrites the index.
   */
  emitValidationAbort(input: ValidationAbortInput): ValidationAbortEvent {
    const event: ValidationAbortEvent = {
      ...this.envelope('validationAbort'),
      validationStage: input.validationStage,
      errorCode: input.errorCode,
      errorPayload: input.errorPayload,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record one clarifier finding — a single ambiguity the clarifier detected
   * while drafting the clarified spec — with its disposition class, gap-class
   * label, round, and structured payload. Returns the persisted event. Side
   * effect: appends an event file and rewrites the index. The inline `payload`
   * is part of the event itself; no payload body is written separately.
   */
  emitClarifierFinding(input: ClarifierFindingInput): ClarifierFindingEvent {
    const event: ClarifierFindingEvent = {
      ...this.envelope('clarifierFinding'),
      class: input.class,
      gapClass: input.gapClass,
      round: input.round,
      payload: input.payload,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record one clarifier draft-preview interaction (the user's action, the
   * round it terminated, and any action-specific payload). Returns the
   * persisted event. Side effect: appends an event file and rewrites the index.
   * The inline `payload` is part of the event itself; no payload body is
   * written separately.
   */
  emitClarifierUserAction(input: ClarifierUserActionInput): ClarifierUserActionEvent {
    const event: ClarifierUserActionEvent = {
      ...this.envelope('clarifierUserAction'),
      action: input.action,
      round: input.round,
      payload: input.payload,
    };
    this.persist(event);
    return event;
  }

  /**
   * Record an independent-review marker — one event per generator attempt the
   * contract-free reviewer inspected. The inlined `payload` carries the
   * lightweight summary the run trace surfaces (sprint, attempt-letter, active
   * contract revision, single-word verdict, per-tier counts + dropped); the
   * reviewer's full per-finding bundle lives in the sibling
   * `sprint-{N}-independent-review-{attempt}.json` artefact, which a reader
   * loads through the artefact path, not through this event.
   *
   * Side effect: appends an event file and rewrites the index. No payload
   * bodies are written separately — the inline `payload` is part of the event
   * itself, mirroring the {@link SafetyHaltEvent} precedent.
   *
   * Why this is its own class and not an `agentAttempt`: the reviewer is
   * off-budget (the sprint-budget guard counts `agentAttempt` events, so
   * routing a review through that channel would mis-fire the guard on a role
   * that does not bear attempts). The reviewer's `llmCall` event is still
   * emitted by the underlying model call, so `aggregateSprintSummary` sums
   * its cost like any other role's — only the budget-bearing `agentAttempt`
   * is withheld.
   *
   * Returns the persisted event.
   */
  emitIndependentReview(input: IndependentReviewInput): IndependentReviewEvent {
    const event: IndependentReviewEvent = {
      ...this.envelope('independentReview'),
      payload: {
        sprintNumber: input.sprintNumber,
        attemptLetter: input.attemptLetter,
        contractRevision: input.contractRevision,
        verdict: input.verdict,
        summary: {
          blockers: input.summary.blockers,
          warnings: input.summary.warnings,
          advisories: input.summary.advisories,
          dropped: input.summary.dropped,
        },
      },
    };
    this.persist(event);
    return event;
  }

  // Build a payload ref and write its body to disk under the trace root,
  // returning the ref. Used for LLM prompt/response bodies; callers only reach
  // it in 'full' redaction mode.
  private storePayload(
    sequenceNumber: number,
    role: string,
    cls: 'prompt' | 'response' | 'arguments' | 'result',
    content: string,
    contentType: PayloadContentType,
  ): string {
    const ref = buildPayloadRef(sequenceNumber, role, cls, contentType);
    writePayloadFile(this.traceRoot, ref, content);
    return ref;
  }

  // Durably record an event: write its event file first (the authoritative
  // log), fold it into the in-memory index, then rewrite the index. Ordering
  // matters — the event file is the source of truth, so it lands before the
  // derived index is rewritten; a crash between the two leaves a recoverable
  // trace that reconcile() can rebuild.
  private persist(event: TraceEvent): void {
    appendEventFile(this.traceRoot, event);
    this.recordInIndex(event);
    writeIndex(this.traceRoot, this.index);
  }

  // Incrementally fold one event into the rolling index summary: bump totals
  // and per-class counts, widen the first/last timestamp window, and capture a
  // milestone disposition. Mirrors buildIndex() so the incremental and
  // from-scratch paths agree.
  private recordInIndex(event: TraceEvent): void {
    const idx = this.index;
    idx.totalEvents += 1;
    idx.countByClass[event.eventType] = (idx.countByClass[event.eventType] ?? 0) + 1;
    if (idx.firstTimestamp === undefined || event.timestamp < idx.firstTimestamp) {
      idx.firstTimestamp = event.timestamp;
    }
    if (idx.lastTimestamp === undefined || event.timestamp > idx.lastTimestamp) {
      idx.lastTimestamp = event.timestamp;
    }
    if (event.eventType === 'orchestratorMilestone' && event.disposition !== undefined) {
      idx.disposition = event.disposition;
    }
  }

  /**
   * Rebuild the index from scratch by re-scanning every event file on disk,
   * replacing the in-memory index with the result, and rewriting `index.json`.
   * Use after a crash or external tampering to restore the index/event-log
   * consistency the incremental path normally maintains. Returns the rebuilt
   * index. Side effect: rewrites `index.json`.
   */
  reconcile(): TraceIndex {
    const index = reconcileIndex(this.traceRoot, this.runId);
    this.index = index;
    return index;
  }
}

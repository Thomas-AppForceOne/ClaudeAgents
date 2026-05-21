/**
 * T1 Sprint 2 — the trace-emission library surface (F2.1–F2.7).
 *
 * `TraceEmitter` is the single object the orchestrator/agent path would hold
 * for a run (the live wiring is Sprint 3; this is the unit-testable library).
 * It owns:
 *
 *  - the monotonic, non-negative, GAPLESS sequence allocator (F2.1);
 *  - the common-envelope stamp (sequenceNumber, eventType, timestamp, runId);
 *  - the seven event-class constructors (F2.2–F2.4), each producing an event
 *    that validates against `run-trace-v1.json`;
 *  - payload storage under `payloads/` with the F2.4 naming scheme, written
 *    atomically (F2.5);
 *  - the `telemetry.tracePayloads` redaction control (F2.7): in `hashed` mode
 *    the content hash is still recorded on the event, but NO payload file is
 *    written; in `full` mode the payload content is written verbatim.
 *
 * Append-only is structural: there is no update/overwrite/delete method on
 * this surface. A correction is a new superseding event with a higher
 * sequence number, produced by calling another constructor.
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

/** Resolved `telemetry.tracePayloads` redaction mode (F2.7). */
export type RedactionMode = 'full' | 'hashed';

export interface TraceEmitterOptions {
  /** Absolute path to the run's trace root (`<run-dir>/trace/`). */
  traceRoot: string;
  /** The run identifier stamped on every envelope. */
  runId: string;
  /** Resolved redaction mode. Defaults to `full` (the spec's v1.0 default). */
  redaction?: RedactionMode;
  /**
   * Sequence number for the first emitted event. Defaults to 0. A recovery
   * caller (Sprint 3) supplies the next number after the archived tail so
   * sequencing continues gaplessly across `--recover`.
   */
  startSequence?: number;
}

/** A payload to store alongside an llmCall: prompt and response content. */
export interface LlmPayloads {
  /** The full prompt content (text). Stored as a `prompt` payload. */
  prompt: string;
  /** The model response content (text). Stored as a `response` payload. */
  response: string;
}

/** A payload to store alongside a toolCall: arguments and result content. */
export interface ToolPayloads {
  /** Tool arguments. A string is text (.md); an object is structured (.json). */
  arguments: string | Record<string, unknown> | unknown[];
  /** Tool result. A string is text (.md); an object is structured (.json). */
  result: string | Record<string, unknown> | unknown[];
}

export interface LlmCallInput {
  role: string;
  /** The logical request identity (the IN-boundary fields) for promptRef. */
  request: LlmRequestIdentity;
  /** The prompt/response content to store (or hash) per the redaction mode. */
  payloads: LlmPayloads;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  latencyMs: number;
  cacheHit: boolean;
}

export interface ToolCallInput {
  tool: string;
  role: string;
  payloads: ToolPayloads;
  disposition: 'completed' | 'failed';
  latencyMs: number;
}

export interface OrchestratorMilestoneInput {
  milestone: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
  summary?: string;
}

export interface AgentAttemptInput {
  role: string;
  attemptNumber: number;
  /** Inputs fed to the agent; hashed into inputDigest. */
  inputs: unknown;
  outputArtifactPath: string;
  disposition: 'completed' | 'objected' | 'failed';
}

export interface SafetyHaltInput {
  safetyClass: string;
  role: string;
  payload: Record<string, unknown>;
}

export interface TrustEventInput {
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  contentHash: string;
}

export interface ValidationAbortInput {
  validationStage: 'config' | 'overlay' | 'stack' | 'module';
  errorCode: string;
  errorPayload: Record<string, unknown>;
}

/**
 * Serialise a tool payload value to its on-disk content and content type. A
 * string is text (`.md`); a structured value is canonical JSON (`.json`).
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

export class TraceEmitter {
  private readonly traceRoot: string;
  private readonly runId: string;
  private readonly redaction: RedactionMode;
  private nextSequence: number;
  /** In-memory index accumulator, updated in O(1) per emit (see `persist`). */
  private index: TraceIndex;
  /** Allows `clock()` injection for deterministic timestamps in tests. */
  private readonly now: () => number;

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
    // Initialise the in-memory index ONCE from any existing on-disk events
    // (empty for a fresh run; populated when resuming after --recover). Each
    // emit then updates this accumulator in O(1) instead of re-scanning and
    // re-validating the whole events directory — the persisted index stays
    // byte-identical to a full buildIndex() over the same events.
    const scan = scanEvents(this.traceRoot);
    this.index = buildIndex(this.runId, scan.events, scan.unknownClassEvents);
  }

  /** The resolved redaction mode in effect. */
  getRedactionMode(): RedactionMode {
    return this.redaction;
  }

  /** The next sequence number that will be allocated (for tests/recovery). */
  peekNextSequence(): number {
    return this.nextSequence;
  }

  /**
   * Allocate the next monotonic, non-negative, GAPLESS sequence number. Each
   * call returns exactly one more than the previous (F2.1).
   */
  private allocateSequence(): number {
    const seq = this.nextSequence;
    this.nextSequence = seq + 1;
    return seq;
  }

  /** Build the common envelope for a freshly allocated sequence number. */
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

  // ---- the seven event-class constructors -------------------------------

  /** Emit an `orchestratorMilestone` event (F2.2). */
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

  /** Emit an `agentAttempt` event (F2.2). */
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
   * Emit an `llmCall` event (F2.3). The `promptRef`/`responseRef` are bare
   * 64-hex content hashes. The prompt hash is the load-bearing boundary hash
   * over the request identity; the response hash is over the response content.
   * In `full` mode the prompt/response content is also written under
   * `payloads/`; in `hashed` mode the hashes are recorded but NO payload files
   * are written (F2.7).
   */
  emitLlmCall(input: LlmCallInput): LlmCallEvent {
    const envelope = this.envelope('llmCall');
    const promptRef = computePromptRef(input.request);
    const responseRef = sha256Hex(input.payloads.response);

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
   * Emit a `toolCall` event (F2.4). `argumentsRef`/`resultRef` are relative
   * POSIX references under `payloads/`. In `hashed` mode the references still
   * point at the deterministic payload filename (so the layout is recoverable)
   * but no content file is written.
   */
  emitToolCall(input: ToolCallInput): ToolCallEvent {
    const envelope = this.envelope('toolCall');
    const args = serialisePayload(input.payloads.arguments);
    const res = serialisePayload(input.payloads.result);

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

  /** Emit a `safetyHalt` event. */
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

  /** Emit a `trustEvent` event. */
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

  /** Emit a `validationAbort` event. */
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

  // ---- payload + index helpers ------------------------------------------

  /**
   * Store one payload file under `payloads/` using the F2.4 naming scheme.
   * Only called in `full` mode; `hashed` mode never reaches here, so payload
   * content is never written when redacted (F2.7 write-time, irreversible).
   */
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

  /**
   * The single persistence path for an emitted event: append the event file
   * (atomic), fold it into the in-memory index in O(1), and write the index
   * LAST. The index is written after the event file and may lag if the process
   * dies between the two writes; reconciliation rebuilds it on next start.
   */
  private persist(event: TraceEvent): void {
    appendEventFile(this.traceRoot, event);
    this.recordInIndex(event);
    writeIndex(this.traceRoot, this.index);
  }

  /**
   * Fold one freshly emitted (known-class) event into the in-memory index,
   * mirroring `buildIndex()`'s per-event logic EXACTLY so the incremental index
   * stays byte-identical to a full rebuild. The emitter only ever emits known
   * classes, so `countByClass` is keyed by fixed v1 type strings (no
   * forbidden-key risk).
   */
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
   * Force a full startup reconciliation of the index against the events
   * (F2.6). Exposed so a recovery caller can reconcile before resuming; the
   * in-memory accumulator is reset to the reconciled result so subsequent
   * incremental updates build on it.
   */
  reconcile(): TraceIndex {
    const index = reconcileIndex(this.traceRoot, this.runId);
    this.index = index;
    return index;
  }
}

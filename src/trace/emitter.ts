

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

export type RedactionMode = 'full' | 'hashed';

export interface TraceEmitterOptions {

  traceRoot: string;

  runId: string;

  redaction?: RedactionMode;

  startSequence?: number;
}

export interface LlmPayloads {

  prompt: string;

  response: string;
}

export interface ToolPayloads {

  arguments: string | Record<string, unknown> | unknown[];

  result: string | Record<string, unknown> | unknown[];
}

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

  private index: TraceIndex;

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

    const scan = scanEvents(this.traceRoot);
    this.index = buildIndex(this.runId, scan.events, scan.unknownClassEvents);
  }

  getRedactionMode(): RedactionMode {
    return this.redaction;
  }

  peekNextSequence(): number {
    return this.nextSequence;
  }

  private allocateSequence(): number {
    const seq = this.nextSequence;
    this.nextSequence = seq + 1;
    return seq;
  }

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

  private persist(event: TraceEvent): void {
    appendEventFile(this.traceRoot, event);
    this.recordInIndex(event);
    writeIndex(this.traceRoot, this.index);
  }

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

  reconcile(): TraceIndex {
    const index = reconcileIndex(this.traceRoot, this.runId);
    this.index = index;
    return index;
  }
}

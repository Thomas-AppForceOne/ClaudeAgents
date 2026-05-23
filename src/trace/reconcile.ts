

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getRunTraceValidator } from '../config-server/validation/schema-check.js';
import { stableStringify } from '../config-server/determinism/index.js';
import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import { KNOWN_EVENT_TYPES, type TraceEvent } from './events.js';
import { eventsDir, indexPath } from './store.js';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface TraceIndex {
  runId: string;
  totalEvents: number;
  countByClass: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
}

export interface UnknownClassEvent {
  sequenceNumber: number;
  eventType: string;
  timestamp: string;
}

export interface ScanResult {

  events: TraceEvent[];

  unknownClassEvents: UnknownClassEvent[];

  warnings: string[];

  malformedEnvelopeCount: number;

  missingSequenceCount: number;
}

export function safeMergeParsedObject(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `The framework refused to merge a trace event carrying the forbidden key '${key}' (prototype-pollution guard).`,
      );
    }

    Object.defineProperty(out, key, {
      value: (parsed as Record<string, unknown>)[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readSequenceNumber(parsed: unknown): number | null {
  if (!isObject(parsed)) return null;
  const seq = parsed.sequenceNumber;
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq;
  return null;
}

function hasWellFormedEnvelope(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.eventType === 'string' &&
    parsed.eventType.length > 0 &&
    typeof parsed.timestamp === 'string' &&
    parsed.timestamp.length > 0 &&
    typeof parsed.runId === 'string' &&
    parsed.runId.length > 0
  );
}

function listEventFiles(traceRoot: string): string[] {
  const dir = eventsDir(traceRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => path.join(dir, n));
}

export function scanEvents(traceRoot: string): ScanResult {
  const validate = getRunTraceValidator();
  const events: TraceEvent[] = [];
  const unknownClassEvents: UnknownClassEvent[] = [];
  const warnings: string[] = [];
  let malformedEnvelopeCount = 0;
  let missingSequenceCount = 0;

  for (const file of listEventFiles(traceRoot)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {

      missingSequenceCount += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      missingSequenceCount += 1;
      continue;
    }

    const seq = readSequenceNumber(parsed);
    if (!isObject(parsed) || seq === null) {

      missingSequenceCount += 1;
      continue;
    }

    let safe: Record<string, unknown>;
    try {
      safe = safeMergeParsedObject(parsed);
    } catch {
      malformedEnvelopeCount += 1;
      continue;
    }

    const eventType = safe.eventType;
    if (
      typeof eventType === 'string' &&
      !KNOWN_EVENT_TYPES.has(eventType) &&
      !FORBIDDEN_KEYS.has(eventType) &&
      hasWellFormedEnvelope(safe)
    ) {
      unknownClassEvents.push({
        sequenceNumber: seq,
        eventType,
        timestamp: safe.timestamp as string,
      });
      warnings.push(
        `The framework encountered an unrecognised trace event class '${eventType}' at sequence ${seq}; skipping it (a newer version of the framework may have produced it).`,
      );
      continue;
    }

    if (!validate(safe)) {
      malformedEnvelopeCount += 1;
      continue;
    }

    events.push(safe as unknown as TraceEvent);
  }

  events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  unknownClassEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { events, unknownClassEvents, warnings, malformedEnvelopeCount, missingSequenceCount };
}

export function buildIndex(
  runId: string,
  events: TraceEvent[],
  unknownClassEvents: readonly UnknownClassEvent[] = [],
): TraceIndex {
  const countByClass: Record<string, number> = Object.create(null) as Record<string, number>;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let disposition: TraceIndex['disposition'];

  const note = (eventType: string, timestamp: string): void => {
    countByClass[eventType] = (countByClass[eventType] ?? 0) + 1;
    if (firstTimestamp === undefined || timestamp < firstTimestamp) firstTimestamp = timestamp;
    if (lastTimestamp === undefined || timestamp > lastTimestamp) lastTimestamp = timestamp;
  };

  for (const ev of events) {
    note(ev.eventType, ev.timestamp);
    if (ev.eventType === 'orchestratorMilestone' && ev.disposition !== undefined) {
      disposition = ev.disposition;
    }
  }
  for (const ev of unknownClassEvents) {
    note(ev.eventType, ev.timestamp);
  }

  const index: TraceIndex = {
    runId,
    totalEvents: events.length + unknownClassEvents.length,

    countByClass: { ...countByClass },
  };
  if (firstTimestamp !== undefined) index.firstTimestamp = firstTimestamp;
  if (lastTimestamp !== undefined) index.lastTimestamp = lastTimestamp;
  if (disposition !== undefined) index.disposition = disposition;
  return index;
}

export function writeIndex(traceRoot: string, index: TraceIndex): void {
  atomicWriteFile(indexPath(traceRoot), stableStringify(index));
}

export function reconcileIndex(traceRoot: string, runId: string): TraceIndex {
  const { events, unknownClassEvents } = scanEvents(traceRoot);
  const index = buildIndex(runId, events, unknownClassEvents);
  writeIndex(traceRoot, index);
  return index;
}

export function isUnrecoverable(traceRoot: string): boolean {
  const { malformedEnvelopeCount, missingSequenceCount } = scanEvents(traceRoot);
  return malformedEnvelopeCount > 0 || missingSequenceCount > 1;
}

export interface RoleAttemptState {

  attemptCount: number;

  highestAttemptNumber: number;
}

export interface RecoveryState {
  nextSequence: number;
  attemptStateByRole: Record<string, RoleAttemptState>;
}

export function reconstructRecoveryState(traceRoot: string): RecoveryState {
  const { events, unknownClassEvents } = scanEvents(traceRoot);

  let highestSequence = -1;
  const attemptStateByRole: Record<string, RoleAttemptState> = Object.create(null) as Record<
    string,
    RoleAttemptState
  >;

  for (const ev of unknownClassEvents) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;
  }

  for (const ev of events) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;

    if (ev.eventType === 'agentAttempt') {
      const role = ev.role;

      if (role === '__proto__' || role === 'constructor' || role === 'prototype') {
        continue;
      }
      const prior = Object.prototype.hasOwnProperty.call(attemptStateByRole, role)
        ? attemptStateByRole[role]!
        : { attemptCount: 0, highestAttemptNumber: 0 };
      attemptStateByRole[role] = {
        attemptCount: prior.attemptCount + 1,
        highestAttemptNumber: Math.max(prior.highestAttemptNumber, ev.attemptNumber),
      };
    }
  }

  return {
    nextSequence: highestSequence + 1,
    attemptStateByRole,
  };
}

export function nextRecoverySequence(traceRoot: string): number {
  return reconstructRecoveryState(traceRoot).nextSequence;
}

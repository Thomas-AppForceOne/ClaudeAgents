/**
 * T1 Sprint 2 — index maintenance, startup reconciliation, and unrecoverable
 * classification (F2.6, F2.8).
 *
 * On-disk event files are UNTRUSTED on read (spec "Trust boundaries"): a file
 * may be partial, malformed, or carry an adversarial parsed object. The
 * reconciliation logic therefore:
 *
 *  - validates each parsed object against the run-trace schema before trusting
 *    its envelope;
 *  - guards against prototype pollution when folding a parsed object's keys
 *    into the reconciled state (rejecting `__proto__` / `constructor` /
 *    `prototype` keys) — a malformed event must never mutate Object.prototype
 *    or the reconciled index;
 *  - treats the EVENTS as authoritative: the index is fully regenerable from
 *    the self-describing event files sorted by sequence number, so a lagging
 *    or disagreeing index is simply rebuilt.
 *
 * The unrecoverable classifier feeds `--list-recoverable`: a run is
 * unrecoverable when (a) any event file has a malformed envelope, OR (b) more
 * than one event file lacks a readable sequence number.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getRunTraceValidator } from '../config-server/validation/schema-check.js';
import { stableStringify } from '../config-server/determinism/index.js';
import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import type { TraceEvent } from './events.js';
import { eventsDir, indexPath } from './store.js';

/** Keys that must never be folded in from untrusted parsed objects. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The derivative index shape (matches `run-trace-index-v1.json`). */
export interface TraceIndex {
  runId: string;
  totalEvents: number;
  countByClass: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
}

/** Outcome of scanning the events directory as untrusted input. */
export interface ScanResult {
  /** Schema-valid events, sorted ascending by sequence number. */
  events: TraceEvent[];
  /** Count of event files whose envelope was malformed (schema-invalid). */
  malformedEnvelopeCount: number;
  /** Count of event files lacking a readable (integer) sequence number. */
  missingSequenceCount: number;
}

/**
 * Reject prototype-pollution keys before merging an untrusted parsed object.
 * Returns a shallow own-property copy with a null prototype, throwing if any
 * forbidden key is present at the top level. Used wherever a parsed-from-disk
 * object's keys would otherwise be folded into framework state.
 */
export function safeMergeParsedObject(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `The framework refused to merge a trace event carrying the forbidden key '${key}' (prototype-pollution guard).`,
      );
    }
    // Use own-property access only; Object.keys already excludes inherited
    // and non-enumerable keys, and `__proto__` as a plain own key (e.g. from
    // JSON.parse) is caught above before this assignment.
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

/**
 * List the event files under `events/`, oldest-first by filename. Returns
 * absolute paths. A missing events directory yields an empty list (an
 * in-progress or never-started run is not an error here).
 */
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

/**
 * Scan the events directory, treating every file as untrusted input. The two
 * unrecoverable predicates (F2.8) are kept ORTHOGONAL so the recoverable
 * control ("well-formed events and AT MOST ONE unreadable-sequence file")
 * holds:
 *
 *  - A file that does not yield a readable (non-negative integer) sequence
 *    number — unparseable JSON, a non-object body, or an object with no/bad
 *    `sequenceNumber` — counts toward `missingSequenceCount`. ONE such file is
 *    the classic interrupted-write tail and is tolerable; MORE than one is
 *    unrecoverable (predicate b). It is NOT also counted as a malformed
 *    envelope, because that would make a single interrupted tail wrongly fatal.
 *  - A file that DOES carry a readable sequence number but otherwise fails
 *    schema validation (or carries a prototype-pollution key) is a genuine
 *    malformed envelope and counts toward `malformedEnvelopeCount` — ANY such
 *    file is unrecoverable (predicate a).
 *
 * No file ever throws out of the scan: untrusted input is classified, never
 * trusted.
 */
export function scanEvents(traceRoot: string): ScanResult {
  const validate = getRunTraceValidator();
  const events: TraceEvent[] = [];
  let malformedEnvelopeCount = 0;
  let missingSequenceCount = 0;

  for (const file of listEventFiles(traceRoot)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // Unreadable file: no recoverable sequence number.
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

    if (!isObject(parsed) || readSequenceNumber(parsed) === null) {
      // No readable sequence number — interrupted-write tail bucket.
      missingSequenceCount += 1;
      continue;
    }

    // The file carries a readable sequence number. From here on, any failure
    // is a genuine malformed envelope (predicate a), not a missing sequence.

    // Guard the untrusted parsed object against prototype pollution before it
    // is folded into framework state.
    let safe: Record<string, unknown>;
    try {
      safe = safeMergeParsedObject(parsed);
    } catch {
      malformedEnvelopeCount += 1;
      continue;
    }

    if (!validate(safe)) {
      malformedEnvelopeCount += 1;
      continue;
    }

    events.push(safe as unknown as TraceEvent);
  }

  events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { events, malformedEnvelopeCount, missingSequenceCount };
}

/**
 * Build the derivative index purely from a set of authoritative events.
 * `disposition` is taken from the last orchestratorMilestone that carries one
 * (the run's terminal disposition); absent while the run is in progress.
 */
export function buildIndex(runId: string, events: TraceEvent[]): TraceIndex {
  const countByClass: Record<string, number> = {};
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let disposition: TraceIndex['disposition'];

  for (const ev of events) {
    countByClass[ev.eventType] = (countByClass[ev.eventType] ?? 0) + 1;
    if (firstTimestamp === undefined || ev.timestamp < firstTimestamp) {
      firstTimestamp = ev.timestamp;
    }
    if (lastTimestamp === undefined || ev.timestamp > lastTimestamp) {
      lastTimestamp = ev.timestamp;
    }
    if (ev.eventType === 'orchestratorMilestone' && ev.disposition !== undefined) {
      disposition = ev.disposition;
    }
  }

  const index: TraceIndex = {
    runId,
    totalEvents: events.length,
    countByClass,
  };
  if (firstTimestamp !== undefined) index.firstTimestamp = firstTimestamp;
  if (lastTimestamp !== undefined) index.lastTimestamp = lastTimestamp;
  if (disposition !== undefined) index.disposition = disposition;
  return index;
}

/** Atomically write the index file (always written last; may lag events). */
export function writeIndex(traceRoot: string, index: TraceIndex): void {
  atomicWriteFile(indexPath(traceRoot), stableStringify(index));
}

/**
 * Startup reconciliation (F2.6): scan the authoritative event files, rebuild
 * the index from them, and write it. Returns the reconciled index. Because
 * the index is regenerated from the events (not merged with the old index),
 * a lagging or disagreeing on-disk index is simply replaced — events win.
 */
export function reconcileIndex(traceRoot: string, runId: string): TraceIndex {
  const { events } = scanEvents(traceRoot);
  const index = buildIndex(runId, events);
  writeIndex(traceRoot, index);
  return index;
}

/**
 * Unrecoverable-run classification (F2.8). A run is unrecoverable when
 *  (a) any event file has a malformed envelope, OR
 *  (b) more than one event file lacks a readable sequence number.
 * Otherwise the run is recoverable. This predicate is what
 * `--list-recoverable` consumes.
 */
export function isUnrecoverable(traceRoot: string): boolean {
  const { malformedEnvelopeCount, missingSequenceCount } = scanEvents(traceRoot);
  return malformedEnvelopeCount > 0 || missingSequenceCount > 1;
}

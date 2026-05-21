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
import { KNOWN_EVENT_TYPES, type TraceEvent } from './events.js';
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

/**
 * A forward-compatible UNKNOWN event-class file: a well-formed envelope whose
 * `eventType` is not one of the v1 known classes. A v1 reader cannot interpret
 * its class-specific fields, so it is skipped from `events` (with a structured
 * warning) — but its envelope is well-formed, so it still counts toward the
 * index and toward gapless sequence continuation. This realises T1's
 * forward-compat reader invariant: a NEW event class entirely stays on v1, and
 * a v1 reader tolerates it by skipping rather than erroring (or wrongly marking
 * the run unrecoverable). When E5 (`clarifierFinding`) / E6 (`humanReview`) add
 * classes on v1, an archived trace carrying one stays recoverable.
 */
export interface UnknownClassEvent {
  sequenceNumber: number;
  eventType: string;
  timestamp: string;
}

/** Outcome of scanning the events directory as untrusted input. */
export interface ScanResult {
  /** Schema-valid events of a KNOWN v1 class, sorted ascending by sequence number. */
  events: TraceEvent[];
  /**
   * Well-formed-envelope events whose `eventType` is not a known v1 class
   * (forward-compat). Skipped from `events`, but counted for the index and for
   * sequence continuation. Sorted ascending by sequence number.
   */
  unknownClassEvents: UnknownClassEvent[];
  /** Structured warnings, one per skipped unknown-class event. */
  warnings: string[];
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
 * True iff a parsed object carries a well-formed common envelope beyond the
 * sequence number: a non-empty string `eventType`, `timestamp`, and `runId`.
 * Used to distinguish a tolerable forward-compat unknown-class event (well-formed
 * envelope, unknown `eventType`) from a genuinely malformed one.
 */
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
 * Forward-compat (T1 reader invariant): a file with a readable sequence number
 * and a WELL-FORMED ENVELOPE whose `eventType` is simply NOT a known v1 class
 * is neither malformed nor missing-sequence — it is a future event class. It is
 * collected into `unknownClassEvents` and emits a structured `warning`, and is
 * skipped from the typed `events` (a v1 reader cannot interpret its body). It
 * does NOT count toward `malformedEnvelopeCount`, so a trace carrying a future
 * additive event class stays recoverable. A forbidden-key `eventType` value
 * (`__proto__`/`constructor`/`prototype`) is excluded from this path and falls
 * through to the malformed bucket.
 *
 * No file ever throws out of the scan: untrusted input is classified, never
 * trusted.
 */
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

    const seq = readSequenceNumber(parsed);
    if (!isObject(parsed) || seq === null) {
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

    // Forward-compat: a well-formed envelope with an UNKNOWN (non-forbidden)
    // event-class type is tolerated, not treated as malformed. Skip it from the
    // typed events with a structured warning; its envelope still counts for the
    // index and for gapless sequence continuation.
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

/**
 * Build the derivative index purely from a set of authoritative events.
 * `disposition` is taken from the last orchestratorMilestone that carries one
 * (the run's terminal disposition); absent while the run is in progress.
 *
 * Forward-compat unknown-class events (well-formed envelope, future event type)
 * are counted too — `totalEvents`, `countByClass[<their type>]`, and the
 * timestamp bounds include them — so the index stays an honest tally even when a
 * newer framework version produced a class this reader cannot interpret.
 * `disposition` is only ever read from a known orchestratorMilestone.
 */
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
    // Re-key onto a plain object so the persisted index is an ordinary JSON
    // map (the null-prototype accumulator above only avoids pollution from a
    // future event-type string during the fold).
    countByClass: { ...countByClass },
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
  const { events, unknownClassEvents } = scanEvents(traceRoot);
  const index = buildIndex(runId, events, unknownClassEvents);
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

/**
 * The per-role attempt-counter state for one agent role, reconstructed purely
 * from the `agentAttempt` events in the trace (F3.8). No external counter
 * file is consulted — the trace IS the counter store, which is the property
 * that lets `--recover` resume A1's ceilings after O2 archives the run.
 */
export interface RoleAttemptState {
  /** Number of `agentAttempt` events recorded for this role. */
  attemptCount: number;
  /** Highest `attemptNumber` seen for this role (the current attempt). */
  highestAttemptNumber: number;
}

/**
 * The recovery state reconstructed from an existing trace (F3.8):
 *
 *  - `nextSequence` — the sequence number to resume with, continuing
 *    GAPLESSLY from where the trace ended (one more than the highest
 *    `sequenceNumber` present; 0 for an empty/never-started trace). Feeding
 *    this as `TraceEmitter.startSequence` continues emission without a gap or
 *    a collision.
 *  - `attemptStateByRole` — per-role attempt-counter state, reconstructed
 *    purely from the `agentAttempt` events (no counter file on disk).
 */
export interface RecoveryState {
  nextSequence: number;
  attemptStateByRole: Record<string, RoleAttemptState>;
}

/**
 * Reconstruct the recovery state from an EXISTING trace (F3.8). Reuses the
 * Sprint-2 `scanEvents` so the prototype-pollution guard and untrusted-input
 * handling are shared — a malformed archived event is dropped by the scan and
 * never folds into the reconstructed counters (web-node.prototype_pollution),
 * and the result is built only from schema-valid events.
 *
 * Sequence resumption is gapless: the next sequence is `highest + 1` across
 * every present event (events are authoritative, so the index is irrelevant
 * here). Attempt reconstruction tallies the `agentAttempt` events per role,
 * recording both the COUNT and the HIGHEST `attemptNumber` seen, with no
 * reliance on any external counter file.
 *
 * The reconstructed `attemptStateByRole` is built on a null-prototype map and
 * keyed only via own-property assignment, so a role string drawn from a
 * (schema-validated) event cannot reach `Object.prototype`.
 */
export function reconstructRecoveryState(traceRoot: string): RecoveryState {
  const { events, unknownClassEvents } = scanEvents(traceRoot);

  let highestSequence = -1;
  const attemptStateByRole: Record<string, RoleAttemptState> = Object.create(null) as Record<
    string,
    RoleAttemptState
  >;

  // Forward-compat: an unknown-class event (skipped from `events`) may hold the
  // highest sequence number. Its envelope is well-formed, so it must count for
  // gapless continuation — otherwise recovery would reuse a sequence number a
  // newer framework version already allocated.
  for (const ev of unknownClassEvents) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;
  }

  for (const ev of events) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;

    if (ev.eventType === 'agentAttempt') {
      const role = ev.role;
      // Defence in depth: never let a forbidden key reach the prototype chain
      // of the reconstructed counter map (the role comes from a schema-valid
      // event, but the kebab-case role pattern already excludes these; this
      // keeps the guard explicit on the recovery fold).
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

/**
 * Convenience for the recovery caller (F3.8): reconstruct the recovery state
 * and return the next sequence number to resume with. Equivalent to
 * `reconstructRecoveryState(traceRoot).nextSequence`.
 */
export function nextRecoverySequence(traceRoot: string): number {
  return reconstructRecoveryState(traceRoot).nextSequence;
}

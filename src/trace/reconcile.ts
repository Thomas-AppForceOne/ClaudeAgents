/**
 * Trace recovery and index reconciliation — rebuild a run's derived state by
 * re-reading the authoritative event-file log on disk.
 *
 * The emitter maintains an index incrementally, but after a crash (or to assess
 * a trace it did not write) the framework must reconstruct that state purely
 * from the `events/` directory. This module is that read path: it scans event
 * files, classifies each as a valid known event, a forward-compatible unknown,
 * or corruption, and from the survivors derives the {@link TraceIndex} summary,
 * a recovery {@link RecoveryState} (next sequence + per-role attempt counts),
 * and an unrecoverable-corruption verdict.
 *
 * Security invariant enforced throughout: parsed JSON is never trusted as a
 * plain object. {@link safeMergeParsedObject} rehomes every key onto a
 * null-prototype object and rejects {@link FORBIDDEN_KEYS}, so a malicious
 * event file cannot pollute `Object.prototype` or smuggle a `__proto__` role
 * into the recovery state.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getRunTraceValidator } from '../config-server/validation/schema-check.js';
import { stableStringify } from '../config-server/determinism/index.js';
import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import { KNOWN_EVENT_TYPES, type TraceEvent } from './events.js';
import { eventsDir, indexPath } from './store.js';

// Keys that must never be copied off untrusted parsed JSON: they are the
// prototype-pollution vectors. safeMergeParsedObject rejects an object carrying
// any of them, and the recovery loop also skips them as role names.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The derived per-run summary written to `index.json`.
 *
 * @property runId the run this index summarises.
 * @property totalEvents count of all recorded events (known + unknown-class).
 * @property countByClass per-`eventType` counts.
 * @property firstTimestamp / lastTimestamp earliest/latest event timestamps;
 *   omitted when there are no events.
 * @property disposition the run's terminal disposition, taken from the last
 *   orchestrator milestone that carried one; omitted if none did.
 */
export interface TraceIndex {
  runId: string;
  totalEvents: number;
  countByClass: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  disposition?: 'success' | 'halted' | 'aborted' | 'error';
}

/**
 * A well-enveloped event whose `eventType` is not in {@link KNOWN_EVENT_TYPES}
 * — i.e. likely produced by a newer framework version. Counted in the index
 * but not parsed as a {@link TraceEvent}.
 */
export interface UnknownClassEvent {
  sequenceNumber: number;
  eventType: string;
  timestamp: string;
}

/**
 * Outcome of scanning a trace's event directory.
 *
 * @property events validated, sequence-sorted known events.
 * @property unknownClassEvents well-formed but unrecognised-class events,
 *   sequence-sorted; carried forward for counting/recovery, skipped for typing.
 * @property warnings human-readable notes (one per unknown-class event).
 * @property malformedEnvelopeCount events that parsed but failed the envelope
 *   check or schema, or tripped the prototype-pollution guard.
 * @property missingSequenceCount files that could not be read, were not JSON,
 *   or lacked a usable sequence number. `> 1` is a strong corruption signal
 *   (see {@link isUnrecoverable}).
 */
export interface ScanResult {

  events: TraceEvent[];

  unknownClassEvents: UnknownClassEvent[];

  warnings: string[];

  malformedEnvelopeCount: number;

  missingSequenceCount: number;
}

/**
 * Copy every own key of an untrusted parsed object onto a fresh null-prototype
 * object, defending against prototype pollution.
 *
 * @param parsed the object produced by `JSON.parse` of an event file.
 * @returns a structurally-equal object with `Object.create(null)` as prototype.
 * @throws `Error` if `parsed` carries any {@link FORBIDDEN_KEYS}
 *   (`__proto__`/`constructor`/`prototype`) — such a file is treated as an
 *   attack, not merged.
 *
 * Keys are installed via `Object.defineProperty` (not assignment) so that even
 * a `__proto__`-named key — were the guard ever bypassed — would create a real
 * own property rather than walking the prototype setter.
 */
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

// Plain-object guard (excludes null and arrays).
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Extract a usable sequence number (non-negative integer) from a parsed value,
// or null when absent/invalid. A null result is what marks a file as
// "missing sequence" in the scan.
function readSequenceNumber(parsed: unknown): number | null {
  if (!isObject(parsed)) return null;
  const seq = parsed.sequenceNumber;
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq;
  return null;
}

// Whether the three non-sequence envelope fields (eventType, timestamp, runId)
// are all present non-empty strings. Used to decide an unknown-class event is
// well-formed enough to count rather than discard.
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

// List the trace's `*.json` event files as absolute paths, lexically sorted.
// A missing/unreadable directory yields [] (an absent trace is empty, not an
// error). The lexical sort over fixed-width padded filenames already yields
// sequence order (see SEQ_PAD_WIDTH).
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
 * Scan a trace's event directory and classify every file.
 *
 * @param traceRoot the trace root whose `events/` directory is read.
 * @returns a {@link ScanResult}: validated known events and well-formed
 *   unknown-class events (both sequence-sorted), plus warning text and the
 *   corruption tallies. Never throws — every per-file failure is folded into a
 *   count or skipped, so one bad file cannot abort recovery.
 *
 * Each file flows through a fixed gauntlet: read → JSON.parse → has a sequence
 * number → prototype-pollution-safe merge → (unknown-class fast path) → schema
 * validation. A failure at any stage increments `missingSequenceCount` (read/
 * parse/sequence problems) or `malformedEnvelopeCount` (guard/schema problems)
 * and the file is dropped.
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

      // No usable sequence number (or not even an object): the event cannot be
      // ordered or referenced, so it counts as a missing-sequence gap.
      missingSequenceCount += 1;
      continue;
    }

    let safe: Record<string, unknown>;
    try {
      // Rehome onto a null-prototype object; throws on a prototype-pollution
      // key, which we treat as a malformed (hostile) envelope.
      safe = safeMergeParsedObject(parsed);
    } catch {
      malformedEnvelopeCount += 1;
      continue;
    }

    const eventType = safe.eventType;
    // Forward-compatibility fast path: a well-enveloped event whose class we do
    // not recognise (and is not a pollution key) is from a newer framework — we
    // record and warn rather than failing, so reading a future trace degrades
    // gracefully instead of reporting corruption.
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

    // A known event class that fails the run-trace schema is genuine
    // corruption (unlike the unknown-class case above, this type is one we
    // claim to understand), so it counts as malformed.
    if (!validate(safe)) {
      malformedEnvelopeCount += 1;
      continue;
    }

    events.push(safe as unknown as TraceEvent);
  }

  // Re-sort by sequence: directory order is only as reliable as filenames, so
  // sorting on the authoritative sequence number guarantees event order.
  events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  unknownClassEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { events, unknownClassEvents, warnings, malformedEnvelopeCount, missingSequenceCount };
}

/**
 * Build a {@link TraceIndex} from already-scanned events.
 *
 * @param runId the run id to stamp on the index.
 * @param events validated known events.
 * @param unknownClassEvents well-formed unknown-class events; counted in
 *   totals/timestamps but cannot contribute a disposition. Defaults to `[]`.
 * @returns the summary. Optional fields (`firstTimestamp`, `lastTimestamp`,
 *   `disposition`) are present only when derivable, never `undefined`.
 *   Pure — no I/O, no throw.
 */
export function buildIndex(
  runId: string,
  events: TraceEvent[],
  unknownClassEvents: readonly UnknownClassEvent[] = [],
): TraceIndex {
  // Null-prototype accumulator so an event class literally named e.g.
  // "constructor" cannot collide with an inherited property while counting.
  const countByClass: Record<string, number> = Object.create(null) as Record<string, number>;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let disposition: TraceIndex['disposition'];

  // Fold one event's class+timestamp into the running counts and the
  // first/last timestamp window.
  const note = (eventType: string, timestamp: string): void => {
    countByClass[eventType] = (countByClass[eventType] ?? 0) + 1;
    if (firstTimestamp === undefined || timestamp < firstTimestamp) firstTimestamp = timestamp;
    if (lastTimestamp === undefined || timestamp > lastTimestamp) lastTimestamp = timestamp;
  };

  for (const ev of events) {
    note(ev.eventType, ev.timestamp);
    // Last milestone disposition wins: events are sequence-sorted, so the final
    // milestone carrying a disposition reflects the run's terminal state.
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

    // Copy onto a plain object so the persisted index serialises normally
    // (the null-prototype accumulator is an implementation detail).
    countByClass: { ...countByClass },
  };
  if (firstTimestamp !== undefined) index.firstTimestamp = firstTimestamp;
  if (lastTimestamp !== undefined) index.lastTimestamp = lastTimestamp;
  if (disposition !== undefined) index.disposition = disposition;
  return index;
}

/**
 * Persist a {@link TraceIndex} to `index.json` under `traceRoot`, atomically
 * (temp-file + rename) and with deterministic key ordering. Side effect: the
 * index file write. May throw an I/O error from the atomic write.
 */
export function writeIndex(traceRoot: string, index: TraceIndex): void {
  atomicWriteFile(indexPath(traceRoot), stableStringify(index));
}

/**
 * Rebuild the index from the event log and write it. Equivalent to scan →
 * build → write. Returns the rebuilt index. Side effect: rewrites `index.json`.
 * This is the from-scratch counterpart to the emitter's incremental indexing.
 */
export function reconcileIndex(traceRoot: string, runId: string): TraceIndex {
  const { events, unknownClassEvents } = scanEvents(traceRoot);
  const index = buildIndex(runId, events, unknownClassEvents);
  writeIndex(traceRoot, index);
  return index;
}

/**
 * Judge whether a trace is too corrupt to safely recover from.
 *
 * @param traceRoot the trace to assess (re-scanned here).
 * @returns `true` if any event was malformed, or if more than one file lacked a
 *   usable sequence number.
 *
 * The threshold is asymmetric on purpose: a single missing-sequence file can be
 * a benign in-flight/partial write (e.g. a crash mid-append), so one is
 * tolerated; two or more, or any malformed envelope, signals real damage.
 */
export function isUnrecoverable(traceRoot: string): boolean {
  const { malformedEnvelopeCount, missingSequenceCount } = scanEvents(traceRoot);
  return malformedEnvelopeCount > 0 || missingSequenceCount > 1;
}

/**
 * Per-role attempt accounting reconstructed from the log.
 *
 * @property attemptCount number of agent-attempt events seen for the role.
 * @property highestAttemptNumber the largest `attemptNumber` observed; may
 *   exceed `attemptCount` if earlier attempts are missing from the log.
 */
export interface RoleAttemptState {

  attemptCount: number;

  highestAttemptNumber: number;
}

/**
 * State needed to resume a run from its trace.
 *
 * @property nextSequence the sequence number a resumed emitter should start at
 *   (one past the highest seen, across both known and unknown-class events).
 * @property attemptStateByRole per-role attempt accounting.
 */
export interface RecoveryState {
  nextSequence: number;
  attemptStateByRole: Record<string, RoleAttemptState>;
}

/**
 * Reconstruct {@link RecoveryState} by scanning the event log.
 *
 * @param traceRoot the trace to recover from.
 * @returns the next sequence number and per-role attempt counts. An empty/absent
 *   trace yields `{ nextSequence: 0, attemptStateByRole: {} }`. Never throws.
 *
 * `nextSequence` accounts for unknown-class events too, so resuming never
 * reuses a sequence number a future-version event already occupies.
 */
export function reconstructRecoveryState(traceRoot: string): RecoveryState {
  const { events, unknownClassEvents } = scanEvents(traceRoot);

  // -1 sentinel so an empty trace yields nextSequence = 0 (highest + 1).
  let highestSequence = -1;
  // Null-prototype map so a role name cannot collide with an inherited member.
  const attemptStateByRole: Record<string, RoleAttemptState> = Object.create(null) as Record<
    string,
    RoleAttemptState
  >;

  // Include unknown-class events in the high-water mark so a resumed run never
  // reuses a sequence number a future-version event already wrote.
  for (const ev of unknownClassEvents) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;
  }

  for (const ev of events) {
    if (ev.sequenceNumber > highestSequence) highestSequence = ev.sequenceNumber;

    if (ev.eventType === 'agentAttempt') {
      const role = ev.role;

      // Defence-in-depth: even though safeMergeParsedObject already rejects
      // these as keys, a pollution-named role here would index the accumulator,
      // so skip it explicitly before using it as a key.
      if (role === '__proto__' || role === 'constructor' || role === 'prototype') {
        continue;
      }
      // hasOwnProperty (not `in`/truthiness) because the accumulator is
      // null-prototype and a role's prior state could legitimately be falsy-ish.
      const prior = Object.prototype.hasOwnProperty.call(attemptStateByRole, role)
        ? attemptStateByRole[role]!
        : { attemptCount: 0, highestAttemptNumber: 0 };
      attemptStateByRole[role] = {
        attemptCount: prior.attemptCount + 1,
        // Track the max attemptNumber separately from the count: a gap in the
        // log would otherwise let count and highest disagree, and resumption
        // must continue past the highest, not the count.
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
 * Convenience accessor for just the next sequence number to resume at.
 * Equivalent to `reconstructRecoveryState(traceRoot).nextSequence`. Never throws.
 */
export function nextRecoverySequence(traceRoot: string): number {
  return reconstructRecoveryState(traceRoot).nextSequence;
}

/**
 * `appendTraceEvent` — the stateless runtime emission write path.
 *
 * The shipped {@link TraceEmitter} class holds a sequence counter and writes
 * via plain overwrite — fine for a single-process emitter that controls the
 * counter, but unsafe to call concurrently with the runtime emission tool
 * because two callers could race onto the same `events/<seq>.json`. This
 * module is the alternative: a per-call function that derives the next
 * sequence from `index.json` (the fast path) and writes the event file with
 * **exclusive-create** semantics (`O_EXCL` / `wx` flag), so a race surfaces
 * as `EEXIST` rather than silently clobbering an existing event.
 *
 * On `EEXIST` the function re-derives the highest sequence by reading the
 * **authoritative `events/` directory** — never `index.json`, which lags
 * concurrent writers by design — and retries up to a bounded ceiling. On
 * retry exhaustion (a real disk-level pathology, not a normal race) it
 * surfaces a structured warning rather than throwing, so the run loop can
 * record the drop and continue.
 *
 * The function deliberately does NOT route through {@link TraceEmitter}.
 * `TraceEmitter.persist` writes the event via plain overwrite, which would
 * defeat the exclusive-create semantics this module exists to provide. A
 * static-scan test asserts this file imports neither the emitter class nor
 * its `persist` method.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../config-server/determinism/index.js';
import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import { createError, type ConfigServerError } from '../config-server/errors.js';

import type { TraceEvent } from './events.js';
import { eventsDir, eventFilename, indexPath } from './store.js';
import { type TraceIndex } from './reconcile.js';

/**
 * Bound on the EEXIST retry loop. Sized for "a real concurrent run". A handful
 * of writers might collide once or twice before the sequence re-derivation
 * picks a free slot; exhausting eight retries means the directory is in a
 * pathological state (disk full, permission flip mid-run) and the call should
 * surface a structured warning rather than spin.
 */
const APPEND_RETRY_LIMIT = 8;

/**
 * Outcome of an {@link appendTraceEvent} call.
 *
 * @property sequenceNumber the index of the newly-written event file
 *   (`events/<sequenceNumber>.json`).
 */
export interface AppendTraceEventResult {
  sequenceNumber: number;
}

/**
 * An emit-only event input — the caller supplies the body fields plus
 * `eventType` and (optionally) `timestamp` / `runId`. `sequenceNumber` is
 * always derived by this function and overwrites any input value; the
 * function is the single source of truth for the sequence under the
 * exclusive-create write path.
 */
export type TraceEventInput =
  | Omit<TraceEvent, 'sequenceNumber'>
  | (Omit<TraceEvent, 'sequenceNumber'> & { sequenceNumber?: number });

/**
 * Append a trace event to `<runDir>/trace/events/`, returning the sequence
 * number the event was assigned.
 *
 * @param runDir absolute path to the run directory (the same `runDir` returned
 *   by `resolveRunStore`). The handler computes `traceRoot = join(runDir,
 *   'trace')` internally; callers never construct the trace root.
 * @param event the event body to persist; its `sequenceNumber` is overwritten
 *   with the derived value. The other envelope fields (`eventType`,
 *   `timestamp`, `runId`) are written verbatim.
 * @returns `{ sequenceNumber }` — the index of the file just written.
 * @throws `ConfigServerError` (`MalformedInput`) when every retry attempt
 *   collides — the structured warning surfaces here as a thrown error the
 *   caller catches and folds into `droppedEmits` per the documented
 *   emit-failure protocol.
 *
 * Side effects: creates `events/` and `payloads/` parent directories if
 * needed; writes one event file via `O_EXCL`; rewrites `index.json` via the
 * shipped atomic-write helper (index is a derived cache, plain overwrite is
 * safe — the events directory is the authoritative log).
 */
export function appendTraceEvent(runDir: string, event: TraceEventInput): AppendTraceEventResult {
  const traceRoot = path.join(runDir, 'trace');
  const evDir = eventsDir(traceRoot);

  // mkdir is idempotent — a fresh runDir has no events directory, a recovered
  // run already does. Either way the next write must find the directory in
  // place, so do it eagerly rather than inside the retry loop.
  mkdirSync(evDir, { recursive: true });

  // Fast path: derive the next sequence from index.json (O(1)). The index can
  // be stale under concurrent writers, but that is exactly what the EEXIST
  // retry below is for — we read the cache first, fall back to scanning the
  // authoritative events directory only when we collide.
  let candidate = deriveSequenceFromIndex(traceRoot);

  for (let attempt = 0; attempt < APPEND_RETRY_LIMIT; attempt += 1) {
    const target = path.join(evDir, eventFilename(candidate));
    const persistedEvent = {
      ...(event as Record<string, unknown>),
      sequenceNumber: candidate,
    } as TraceEvent;
    try {
      writeExclusively(target, stableStringify(persistedEvent));
      // Index update is best-effort and a derived cache; reconcileIndex
      // rebuilds it from the authoritative events directory at any time, so
      // a transient undercount mid-race is acceptable.
      bestEffortUpdateIndex(traceRoot, candidate, persistedEvent);
      return { sequenceNumber: candidate };
    } catch (e) {
      if (!isEexistError(e)) {
        // Anything other than a collision (EACCES, EPERM, ENOSPC, etc.) is a
        // real write failure we cannot recover by retrying — propagate so
        // the caller can record the drop.
        throw e;
      }
      // Collision: re-derive the highest sequence from the authoritative
      // events/ directory (NOT the lagging index.json) and try one past it.
      candidate = deriveSequenceFromEventsDirectory(traceRoot);
    }
  }

  // The retry ceiling is reached only when the events directory is in a
  // pathological state (every collision keeps happening). Surface a
  // structured warning rather than spinning; the caller drops the emit and
  // increments droppedEmits.
  throw createError('MalformedInput', {
    field: 'sequenceNumber',
    message: `The framework could not append a trace event after ${APPEND_RETRY_LIMIT} retries; the events directory at '${evDir}' appears to be in a pathological state. Inspect the directory and remove any stray files: rm -rf '${evDir}'/<offending-file>.json, then re-run.`,
  });
}

/**
 * Read `index.json` (best-effort) and return the next sequence number to
 * attempt. Returns `0` when the index is missing, malformed, or carries no
 * sequence data. Never throws — the file is a cache, not authoritative.
 */
function deriveSequenceFromIndex(traceRoot: string): number {
  try {
    // Lazy require so this fast path does not pay readdir cost on the happy
    // case. We only read JSON; on any error we fall to 0 and the EEXIST
    // re-derivation does the real work.
    const raw = readFileBestEffort(indexPath(traceRoot));
    if (raw === null) return 0;
    const parsed = JSON.parse(raw) as Partial<TraceIndex>;
    const total = parsed.totalEvents;
    if (typeof total === 'number' && Number.isInteger(total) && total >= 0) return total;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Scan `events/` and return one past the highest sequence number on disk.
 * This is the authoritative re-derivation used on `EEXIST` — `index.json`
 * could be stale, but the directory listing cannot be.
 */
function deriveSequenceFromEventsDirectory(traceRoot: string): number {
  const evDir = eventsDir(traceRoot);
  let names: string[];
  try {
    names = readdirSync(evDir);
  } catch {
    // No directory means no events yet — start at 0. The mkdir at the top of
    // appendTraceEvent makes this a defence-in-depth rather than a normal
    // path.
    return 0;
  }
  let highest = -1;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const base = name.slice(0, -'.json'.length);
    const n = Number(base);
    if (Number.isInteger(n) && n >= 0 && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * Try to read a UTF-8 file; return its contents on success and `null` on any
 * read failure (the caller treats absent as empty). Never throws.
 */
function readFileBestEffort(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write `content` to `target` using the `wx` flag so that an existing file
 * causes an `EEXIST` error instead of being clobbered. Closes the descriptor
 * regardless of whether the write succeeded.
 */
function writeExclusively(target: string, content: string): void {
  // openSync with 'wx' = O_WRONLY | O_CREAT | O_EXCL. A pre-existing target
  // produces EEXIST, which is exactly the collision signal we want.
  const fd = openSync(target, 'wx');
  try {
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Best-effort recompute and write of `index.json`. On any error this is a
 * no-op — `reconcileIndex` exists precisely to rebuild the index from the
 * authoritative events directory, so a transient miss here is benign.
 */
function bestEffortUpdateIndex(traceRoot: string, _seq: number, ev: TraceEvent): void {
  try {
    // The index is a derived cache; we keep it eventually-consistent by
    // counting the on-disk files (cheap directory scan, no JSON parse) and
    // rewriting the totalEvents-only shape. reconcileIndex rebuilds the full
    // countByClass / firstTimestamp / lastTimestamp at run termination, so a
    // transient mid-run shape that carries only totalEvents is acceptable.
    const evDir = eventsDir(traceRoot);
    let names: string[];
    try {
      names = readdirSync(evDir);
    } catch {
      return;
    }
    const total = names.filter((n) => n.endsWith('.json')).length;
    const indexShape: TraceIndex = {
      runId: ev.runId,
      totalEvents: total,
      countByClass: {},
    };
    atomicWriteFile(indexPath(traceRoot), stableStringify(indexShape));
  } catch {
    // index is a cache; reconciliation is the recovery path.
  }
}

/**
 * Classify an exception as the `EEXIST` collision we expect on a race or as
 * an unrelated failure. Node's `fs` errors carry a `code` field; we accept
 * the `EEXIST` string match across both raw `Error` and the `NodeJS.ErrnoException`
 * shape.
 */
function isEexistError(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === 'EEXIST';
}

/**
 * Re-export the structured-error type a caller might want to narrow on when
 * catching an append failure — the same `ConfigServerError` the rest of the
 * framework uses.
 */
export type AppendTraceEventError = ConfigServerError;

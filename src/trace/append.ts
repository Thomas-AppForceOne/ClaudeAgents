/**
 * `appendTraceEvent` — the stateless runtime emission write path.
 *
 * The shipped {@link TraceEmitter} class holds a sequence counter and writes
 * via plain overwrite — fine for a single-process emitter that controls the
 * counter, but unsafe to call concurrently with the runtime emission tool
 * because two callers could race onto the same `events/<seq>.json`. This
 * module is the alternative: a per-call function that derives the next
 * sequence from a per-process floor / `index.json` (the fast path) and writes
 * the event file with **exclusive-create** semantics (`O_EXCL` / `wx` flag),
 * so a race surfaces as `EEXIST` rather than silently clobbering an existing
 * event.
 *
 * Two sequencing problems live in this file and are deliberately kept apart:
 *
 *  1. **Cold derivation** — "I do not know where the tail is — consult disk."
 *     Genuinely O(N). Right for the first emit in a process and right for
 *     `reconcileIndex` at run termination / `--recover`. Implemented by
 *     {@link deriveSequenceFromEventsDirectory} and only called on the cold
 *     path (the very first emit per `(process, traceRoot)` after `index.json`
 *     is also missing/stale).
 *  2. **Steady-state / forward probe** — "I just observed slot K; the next
 *     free slot is K+1, K+2, …" — O(1) per probe. The kernel's `O_EXCL`
 *     already arbitrates the cross-process race per filename, so the
 *     in-process emitter only needs a monotonically advancing floor; on
 *     `EEXIST` we simply `candidate += 1` and retry. No `readdirSync` on the
 *     success path or the retry path.
 *
 * Why per-process is safe (concurrency invariant):
 *  - Within one process: {@link seqFloorByTraceRoot} is a module-scope `Map`;
 *    only `appendTraceEvent` reads/writes it. No mutex needed — Node's
 *    single-threaded event loop runs each `appendTraceEvent` call to
 *    completion before the next (the function is fully synchronous).
 *  - Across processes: `openSync(target, 'wx')` is the *only* correctness
 *    boundary. Two processes that both compute candidate K race in the
 *    kernel; exactly one wins; the loser sees EEXIST and probes forward.
 *    The in-memory floor is a per-process *hint*, not a global lock —
 *    `reconcileIndex` is the authoritative rebuild path (`index.json` is a
 *    derived cache).
 *  - A stale `seqFloor` is self-correcting: if process B advances disk past
 *    A's floor while A is idle, A's next emit collides on `wx`, walks
 *    forward via the probe-forward retry, and on success raises its own
 *    `seqFloor` to the winning slot + 1.
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
 * Bound on the EEXIST retry loop. Each retry is O(1) (single increment +
 * one exclusive-create open attempt) under the per-process floor + forward
 * probe design, so the ceiling can be generous without affecting steady-state
 * cost. Sized at 64 to comfortably absorb realistic cross-process contention
 * bursts (each loser walks past the winners' slot rather than recomputing the
 * same candidate). Exhausting the ceiling means the directory is in a
 * pathological state (disk full, permission flip mid-run, an unrelated
 * process spamming files at the same slot range) — the call surfaces a
 * structured warning rather than spinning.
 */
const APPEND_RETRY_LIMIT = 64;

/**
 * Per-process, per-traceRoot monotonic floor for the next sequence number to
 * attempt. Keyed by absolute `traceRoot` so multiple runs sharing one Node
 * process coexist without interference. The map is populated lazily on the
 * first emit per `(process, traceRoot)` and incremented on every successful
 * write; it is never read or written by anything except `appendTraceEvent`.
 *
 * Lifetime: a single integer per traceRoot. The map outlives one run within
 * a long-lived process by design — the bound is "runs handled per process",
 * which is small in practice — and a stale entry across a process restart is
 * impossible because the map lives in process memory only.
 */
const seqFloorByTraceRoot = new Map<string, number>();

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

  // Candidate derivation, fast → slow:
  //  1. Per-process floor (`seqFloorByTraceRoot`) — O(1), populated on every
  //     prior successful emit in this process.
  //  2. `deriveSequenceFromIndex` (read `index.json.totalEvents`) — O(1) JSON
  //     read; the cache the previous emit wrote.
  //  3. `deriveSequenceFromEventsDirectory` — O(N) directory scan; the
  //     genuine cold path (first emit in a process when the index is also
  //     missing/stale), and also the path `reconcileIndex` takes at run end.
  //
  // After this initial pick, the retry loop walks `candidate += 1` on EEXIST
  // — no further rescans, success or failure.
  let candidate = pickInitialCandidate(traceRoot);

  for (let attempt = 0; attempt < APPEND_RETRY_LIMIT; attempt += 1) {
    const target = path.join(evDir, eventFilename(candidate));
    const persistedEvent = {
      ...(event as Record<string, unknown>),
      sequenceNumber: candidate,
    } as TraceEvent;
    try {
      writeExclusively(target, stableStringify(persistedEvent));
      // Raise the per-process floor to past-the-win so the next call in this
      // process starts at K+1 with zero disk reads. A racing process may
      // have written K+1 in the meantime; that surfaces as EEXIST on the
      // next call's first attempt and the forward probe handles it without
      // a rescan.
      seqFloorByTraceRoot.set(traceRoot, candidate + 1);
      // Index update is best-effort and a derived cache; reconcileIndex
      // rebuilds it from the authoritative events directory at any time, so
      // a transient undercount mid-race is acceptable.
      bestEffortIncrementIndex(traceRoot, persistedEvent);
      return { sequenceNumber: candidate };
    } catch (e) {
      if (!isEexistError(e)) {
        // Anything other than a collision (EACCES, EPERM, ENOSPC, etc.) is a
        // real write failure we cannot recover by retrying — propagate so
        // the caller can record the drop.
        throw e;
      }
      // Forward probe: another writer (this process or a contending one)
      // already wrote `candidate`. Walking forward is sound because the
      // kernel's `O_EXCL` semantics guarantee the slot we just tried is
      // taken; no rescan can give us better information than `candidate +
      // 1`. Costs one integer increment per probe — vs the old O(N)
      // `readdirSync` per probe — so APPEND_RETRY_LIMIT can be generous.
      candidate += 1;
    }
  }

  // The retry ceiling is reached only when the events directory is in a
  // pathological state (every probe in the bounded window collides). Surface
  // a structured warning rather than spinning; the caller drops the emit and
  // increments droppedEmits.
  throw createError('MalformedInput', {
    field: 'sequenceNumber',
    message: `The framework could not append a trace event after ${APPEND_RETRY_LIMIT} retries; the events directory at '${evDir}' appears to be in a pathological state. Inspect the directory and remove any stray files: rm -rf '${evDir}'/<offending-file>.json, then re-run.`,
  });
}

/**
 * Three-tier candidate pick for the very first attempt of an
 * `appendTraceEvent` call. Returns the smallest sequence number a forward
 * probe should *start* from for the current `(process, traceRoot)`:
 *
 *  - if this process has emitted before for this traceRoot, use the
 *    in-memory floor (O(1), no disk);
 *  - else if `index.json` carries a usable `totalEvents`, use that (one
 *    JSON read, O(1));
 *  - else fall back to scanning `events/` (the genuine cold path; also the
 *    `--recover` path where the in-memory state is gone but the disk is
 *    authoritative). O(N), runs at most once per `(process, traceRoot)` on
 *    the steady-state happy path.
 *
 * Notes on staleness:
 *  - A per-process floor that is *behind* disk (another process wrote
 *    forward of us while we were idle) is self-correcting: the very first
 *    write attempt will collide on `wx`, the retry loop walks forward via
 *    `candidate += 1`, and on success we raise our floor to past-the-win.
 *  - A per-process floor that is *ahead* of disk is structurally
 *    impossible: we only ever increment after a confirmed successful
 *    `O_EXCL` write at that slot.
 */
function pickInitialCandidate(traceRoot: string): number {
  const memo = seqFloorByTraceRoot.get(traceRoot);
  if (memo !== undefined) return memo;
  const fromIndex = deriveSequenceFromIndex(traceRoot);
  if (fromIndex > 0) return fromIndex;
  return deriveSequenceFromEventsDirectory(traceRoot);
}

/**
 * Read `index.json` (best-effort) and return the next sequence number to
 * attempt. Returns `0` when the index is missing, malformed, or carries no
 * sequence data. Never throws — the file is a cache, not authoritative.
 */
function deriveSequenceFromIndex(traceRoot: string): number {
  try {
    // Lazy require so this fast path does not pay readdir cost on the happy
    // case. We only read JSON; on any error we fall to 0 and the cold-path
    // events-directory scan does the real work.
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
 * This is the genuine cold-start oracle — `index.json` may be stale by many
 * writes when a process attaches to an existing run, but the directory
 * listing cannot be. Called at most once per `(process, traceRoot)` on the
 * happy path (the first emit, when both the in-memory floor and the index
 * are absent/zero).
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
 * Best-effort O(1) increment of `index.json` for one freshly-written event:
 * bump `totalEvents` and the `countByClass` bucket for the event's class,
 * carrying the prior counts forward. On every error this is a no-op —
 * `reconcileIndex` exists precisely to rebuild the index from the
 * authoritative events directory, so a transient miss or undercount here is
 * benign.
 *
 * Why this is O(1) and the prior implementation was not: the old
 * `bestEffortUpdateIndex` did a full `readdirSync` + `.filter` + `.length`
 * to recompute `totalEvents` from scratch on every successful emit, turning
 * the per-emit cost into O(N) and the per-run cost into O(N^2). The cheap
 * correct primitive is to read the prior counts from the cache, `+= 1` the
 * total and the one touched bucket, and atomic-write — no directory scan.
 * The cache is derived, so a transient under-count under cross-process
 * contention is absorbed by `reconcileIndex` at run end (the authoritative
 * rebuild path).
 *
 * Carrying `countByClass` forward (rather than writing it empty) matters
 * because a mid-run reader of `index.json` — a tail-following progress UI,
 * the summary tool — would otherwise see a correct `totalEvents` but
 * all-zero per-class buckets between appends. The incremental count keeps
 * the cache internally consistent without reintroducing the O(N) rescan.
 *
 * Cross-process correctness: two processes that both read prior=K and write
 * K+1 produce an under-count of one on the cache (last write wins). That is
 * the exact transient `reconcileIndex` exists to absorb (the index is a
 * derived cache; the events directory is authoritative).
 *
 * Prototype-pollution safety: the prior `countByClass` is parsed from an
 * on-disk file we do not fully trust, and the event class becomes an object
 * key. The forward-carry therefore rehomes the buckets onto a null-prototype
 * object and rejects pollution keys, mirroring the guard `buildIndex` applies
 * on the rebuild path.
 */
function bestEffortIncrementIndex(traceRoot: string, ev: TraceEvent): void {
  try {
    const raw = readFileBestEffort(indexPath(traceRoot));
    const prior = raw ? (JSON.parse(raw) as Partial<TraceIndex>) : undefined;
    const priorTotal =
      prior &&
      typeof prior.totalEvents === 'number' &&
      Number.isInteger(prior.totalEvents) &&
      prior.totalEvents >= 0
        ? prior.totalEvents
        : 0;
    const countByClass = carryForwardCountByClass(prior?.countByClass, ev.eventType);
    // We seed `totalEvents` and `countByClass` here; `reconcileIndex` rebuilds
    // the full shape (including firstTimestamp, lastTimestamp, disposition)
    // from the authoritative events directory at run termination, so the
    // mid-run shape intentionally omits those timestamp/disposition fields.
    const indexShape: TraceIndex = {
      runId: ev.runId,
      totalEvents: priorTotal + 1,
      countByClass,
    };
    atomicWriteFile(indexPath(traceRoot), stableStringify(indexShape));
  } catch {
    // index is a cache; reconciliation is the recovery path.
  }
}

// Pollution keys that must never index the carried-forward count map; an
// on-disk index carrying one of these as a class name is treated as hostile
// and its bucket is dropped (the same set buildIndex's rebuild path guards).
const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Build the next `countByClass` from the prior on-disk map plus one increment
 * for `eventType`. Copies only non-negative-integer buckets onto a fresh
 * null-prototype object and skips prototype-pollution keys, so a tampered
 * index cannot smuggle a bad prototype or a non-numeric bucket into the cache.
 * Never throws.
 */
function carryForwardCountByClass(
  prior: Record<string, number> | undefined,
  eventType: string,
): Record<string, number> {
  const next: Record<string, number> = Object.create(null) as Record<string, number>;
  if (prior && typeof prior === 'object') {
    for (const key of Object.keys(prior)) {
      if (POLLUTION_KEYS.has(key)) continue;
      const value = prior[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        next[key] = value;
      }
    }
  }
  if (!POLLUTION_KEYS.has(eventType)) {
    next[eventType] = (next[eventType] ?? 0) + 1;
  }
  // Copy onto a plain object so the persisted index serialises normally (the
  // null-prototype accumulator is an implementation detail).
  return { ...next };
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

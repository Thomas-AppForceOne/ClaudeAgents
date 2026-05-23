/**
 * Trace filesystem store — the layer that turns the encoding rules into actual
 * paths and atomic writes under a trace root.
 *
 * The path helpers ({@link eventsDir}, {@link payloadsDir}, {@link indexPath},
 * {@link eventFilename}) compute where things live; the write helpers
 * ({@link appendEventFile}, {@link writePayloadFile}) persist them. Two
 * guarantees hold across every write here, stated once:
 *
 * 1. Confinement: nothing is written outside the trace root. Event files use a
 *    name derived only from a validated sequence number; payload writes route
 *    through {@link resolveRefWithinRoot}, which re-validates and resolves the
 *    ref and refuses any path that escapes the root.
 * 2. Atomicity: every write goes through {@link atomicWriteFile} (temp-file +
 *    rename), so a crash mid-write cannot leave a half-written event or payload.
 */

import path from 'node:path';

import { atomicWriteFile } from '../config-server/storage/atomic-write.js';
import { stableStringify } from '../config-server/determinism/index.js';
import { createError } from '../config-server/errors.js';
import {
  EVENTS_DIRNAME,
  INDEX_FILENAME,
  PAYLOADS_DIRNAME,
  padSequence,
  assertSafeRelativeRef,
} from './encodings.js';
import type { TraceEvent } from './events.js';

/** Absolute path to the events directory under `traceRoot`. */
export function eventsDir(traceRoot: string): string {
  return path.join(traceRoot, EVENTS_DIRNAME);
}

/** Absolute path to the payloads directory under `traceRoot`. */
export function payloadsDir(traceRoot: string): string {
  return path.join(traceRoot, PAYLOADS_DIRNAME);
}

/** Absolute path to the `index.json` summary under `traceRoot`. */
export function indexPath(traceRoot: string): string {
  return path.join(traceRoot, INDEX_FILENAME);
}

/**
 * The event filename for a sequence number: zero-padded then `.json`. Throws
 * `MalformedInput` (via {@link padSequence}) for a non-negative-integer
 * violation.
 */
export function eventFilename(sequenceNumber: number): string {
  return `${padSequence(sequenceNumber)}.json`;
}

/**
 * Resolve a relative trace ref to an absolute path, enforcing that it stays
 * within the trace root.
 *
 * @param traceRoot the confining root.
 * @param ref a relative POSIX ref (e.g. a payload ref).
 * @returns the resolved absolute path, guaranteed under `root`.
 * @throws `PathEscape` when `ref` fails {@link assertSafeRelativeRef}, or when —
 *   after resolution — it equals the root itself, climbs above it (`..`), or is
 *   absolute. The post-resolution recheck is defence-in-depth on top of the
 *   syntactic check, since symlinks/normalisation could otherwise differ from
 *   the raw string.
 */
export function resolveRefWithinRoot(traceRoot: string, ref: string): string {
  assertSafeRelativeRef(ref);
  const root = path.resolve(traceRoot);
  const resolved = path.resolve(root, ref);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw createError('PathEscape', {
      message: `The framework refused to write a trace payload outside the trace root (ref '${ref}').`,
      field: 'ref',
    });
  }
  return resolved;
}

/**
 * Atomically write an event to `events/<padded-seq>.json` under `traceRoot`,
 * serialised deterministically.
 *
 * @param traceRoot the trace root.
 * @param event the event to persist; its `sequenceNumber` names the file.
 * @returns the absolute path written.
 * @throws `MalformedInput` for a bad sequence number; I/O errors from the
 *   atomic write propagate. Side effect: the event file write.
 */
export function appendEventFile(traceRoot: string, event: TraceEvent): string {
  const target = path.join(eventsDir(traceRoot), eventFilename(event.sequenceNumber));
  atomicWriteFile(target, stableStringify(event));
  return target;
}

/**
 * Atomically write a payload body to the file named by `ref`, confined to the
 * trace root.
 *
 * @param traceRoot the trace root.
 * @param ref the payload's relative ref; resolved + confined via
 *   {@link resolveRefWithinRoot}.
 * @param content the body to write verbatim.
 * @returns the absolute path written.
 * @throws `PathEscape` when `ref` escapes the root; I/O errors from the atomic
 *   write propagate. Side effect: the payload file write.
 */
export function writePayloadFile(traceRoot: string, ref: string, content: string): string {
  const target = resolveRefWithinRoot(traceRoot, ref);
  atomicWriteFile(target, content);
  return target;
}

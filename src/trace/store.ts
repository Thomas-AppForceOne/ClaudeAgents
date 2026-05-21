/**
 * T1 Sprint 2 — on-disk layout for a run's trace directory and the
 * append-only, atomic write path for event files (F2.4, F2.5).
 *
 * Layout under the trace root (`<run-dir>/trace/`):
 *
 *   trace/
 *     events/      one file per event, named <seq(10)>.json
 *     payloads/    one file per stored payload, named per encodings.ts
 *     index.json   derivative summary, written LAST (may lag the events)
 *
 * Every write — event file and payload file alike — goes through the existing
 * `atomicWriteFile` (temp-file + rename); there is no second write mechanism.
 * Append-only is enforced structurally: this module exposes only write/append
 * helpers, never an in-place update or delete.
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

/** Resolve the absolute events directory for a trace root. */
export function eventsDir(traceRoot: string): string {
  return path.join(traceRoot, EVENTS_DIRNAME);
}

/** Resolve the absolute payloads directory for a trace root. */
export function payloadsDir(traceRoot: string): string {
  return path.join(traceRoot, PAYLOADS_DIRNAME);
}

/** Resolve the absolute index path for a trace root. */
export function indexPath(traceRoot: string): string {
  return path.join(traceRoot, INDEX_FILENAME);
}

/** Event-file name for a sequence number: `<seq(10)>.json`. */
export function eventFilename(sequenceNumber: number): string {
  return `${padSequence(sequenceNumber)}.json`;
}

/**
 * Resolve a trace-root-relative POSIX reference to an absolute path, refusing
 * any reference that would escape the trace root. The reference is validated
 * with the same path-escape rules used at construction time, then resolved
 * and re-checked against the trace root so a write can never land outside
 * `<trace-root>/payloads/` (defence in depth for F2.4 / the spec's
 * filesystem-scoped authorisation).
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
 * Append a single event to the trace by atomically writing its own file under
 * `events/`. The file is named purely from the sequence number so the events
 * directory is self-describing and sortable. Events are written canonically
 * (sorted keys, trailing newline) so a regenerated index is byte-stable.
 *
 * This is the ONLY event write path. There is no overwrite/update/delete
 * counterpart — append-only is a structural property of the surface.
 */
export function appendEventFile(traceRoot: string, event: TraceEvent): string {
  const target = path.join(eventsDir(traceRoot), eventFilename(event.sequenceNumber));
  atomicWriteFile(target, stableStringify(event));
  return target;
}

/**
 * Atomically write a payload file given a trace-root-relative reference and
 * its content. The reference is resolved-and-confined before the write, so an
 * adversarial ref can never escape the trace root.
 */
export function writePayloadFile(traceRoot: string, ref: string, content: string): string {
  const target = resolveRefWithinRoot(traceRoot, ref);
  atomicWriteFile(target, content);
  return target;
}

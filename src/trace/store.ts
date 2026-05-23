

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

export function eventsDir(traceRoot: string): string {
  return path.join(traceRoot, EVENTS_DIRNAME);
}

export function payloadsDir(traceRoot: string): string {
  return path.join(traceRoot, PAYLOADS_DIRNAME);
}

export function indexPath(traceRoot: string): string {
  return path.join(traceRoot, INDEX_FILENAME);
}

export function eventFilename(sequenceNumber: number): string {
  return `${padSequence(sequenceNumber)}.json`;
}

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

export function appendEventFile(traceRoot: string, event: TraceEvent): string {
  const target = path.join(eventsDir(traceRoot), eventFilename(event.sequenceNumber));
  atomicWriteFile(target, stableStringify(event));
  return target;
}

export function writePayloadFile(traceRoot: string, ref: string, content: string): string {
  const target = resolveRefWithinRoot(traceRoot, ref);
  atomicWriteFile(target, content);
  return target;
}

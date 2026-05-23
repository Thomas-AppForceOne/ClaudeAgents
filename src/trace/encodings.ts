

import { createError } from '../config-server/errors.js';

export type PayloadClass = 'prompt' | 'response' | 'arguments' | 'result';

const PAYLOAD_CLASSES: ReadonlySet<string> = new Set(['prompt', 'response', 'arguments', 'result']);

export type PayloadContentType = 'text' | 'structured';

export const PAYLOADS_DIRNAME = 'payloads';

export const EVENTS_DIRNAME = 'events';

export const INDEX_FILENAME = 'index.json';

export const SEQ_PAD_WIDTH = 10;

const ROLE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw createError('MalformedInput', {
      message: 'The framework received a non-finite timestamp for a trace event.',
      field: 'timestamp',
    });
  }
  return new Date(epochMs).toISOString();
}

export function padSequence(sequenceNumber: number): string {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) {
    throw createError('MalformedInput', {
      message:
        'The framework requires a non-negative integer sequence number to build a payload filename.',
      field: 'sequenceNumber',
    });
  }
  return String(sequenceNumber).padStart(SEQ_PAD_WIDTH, '0');
}

export function assertRoleId(role: string): string {
  if (typeof role !== 'string' || !ROLE_ID_PATTERN.test(role)) {
    throw createError('MalformedInput', {
      message: `The framework rejected an invalid agent role '${String(
        role,
      )}'. Roles are kebab-case ASCII (e.g. gan-generator).`,
      field: 'role',
    });
  }
  return role;
}

export function assertPayloadClass(cls: string): PayloadClass {
  if (typeof cls !== 'string' || !PAYLOAD_CLASSES.has(cls)) {
    throw createError('MalformedInput', {
      message: `The framework rejected an unknown payload class '${String(
        cls,
      )}'. Allowed classes are prompt, response, arguments, result.`,
      field: 'class',
    });
  }
  return cls as PayloadClass;
}

export function extensionFor(contentType: PayloadContentType): string {
  return contentType === 'structured' ? 'json' : 'md';
}

export function buildPayloadFilename(
  sequenceNumber: number,
  role: string,
  cls: string,
  contentType: PayloadContentType,
): string {
  const seq = padSequence(sequenceNumber);
  const safeRole = assertRoleId(role);
  const safeClass = assertPayloadClass(cls);
  const ext = extensionFor(contentType);
  return `${seq}-${safeRole}-${safeClass}.${ext}`;
}

export function buildPayloadRef(
  sequenceNumber: number,
  role: string,
  cls: string,
  contentType: PayloadContentType,
): string {
  const filename = buildPayloadFilename(sequenceNumber, role, cls, contentType);
  const ref = `${PAYLOADS_DIRNAME}/${filename}`;
  return assertSafeRelativeRef(ref);
}

export function assertSafeRelativeRef(ref: string): string {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.startsWith('/') ||
    ref.includes('\\') ||
    /(^|\/)\.\.(\/|$)/.test(ref)
  ) {
    throw createError('PathEscape', {
      message: `The framework rejected a trace payload reference '${String(
        ref,
      )}' that is not a confined relative POSIX path under the trace root.`,
      field: 'ref',
    });
  }
  return ref;
}

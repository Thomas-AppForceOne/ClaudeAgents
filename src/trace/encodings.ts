/**
 * T1 Sprint 2 — field-encoding helpers for the trace-emission library.
 *
 * The encodings here are the single source of truth for how the library
 * stamps the load-bearing envelope fields and constructs payload filenames.
 * They mirror the "Field encodings" section of the T1 spec verbatim and the
 * `run-trace-v1.json` schema patterns, so a constructed event always passes
 * `getRunTraceValidator` (closed-loop in the unit tests).
 *
 * Specifically:
 *  - Timestamps: RFC 3339 UTC with millisecond precision (the trailing `Z`
 *    and a `.mmm` fraction are mandatory; local timezones are forbidden).
 *  - Sequence numbers: monotonic non-negative integers, no gaps; zero-padded
 *    to exactly 10 digits in payload filenames.
 *  - Role IDs: kebab-case ASCII (e.g. `gan-generator`).
 *  - Payload classes: one of `prompt | response | arguments | result`.
 *  - Payload references: relative POSIX from the trace root, no leading
 *    separator, no `..` traversal, no backslashes.
 */

import { createError } from '../config-server/errors.js';

/** The four payload classes pinned by F2.4. */
export type PayloadClass = 'prompt' | 'response' | 'arguments' | 'result';

const PAYLOAD_CLASSES: ReadonlySet<string> = new Set([
  'prompt',
  'response',
  'arguments',
  'result',
]);

/** Payload extension by content type: `md` for text, `json` for structured. */
export type PayloadContentType = 'text' | 'structured';

/** Directory (relative to the trace root) under which payload files live. */
export const PAYLOADS_DIRNAME = 'payloads';

/** Directory (relative to the trace root) under which event files live. */
export const EVENTS_DIRNAME = 'events';

/** Filename (relative to the trace root) of the derivative index. */
export const INDEX_FILENAME = 'index.json';

/** Width of the zero-padded sequence number in payload/event filenames. */
export const SEQ_PAD_WIDTH = 10;

const ROLE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Format an absolute epoch-millisecond instant as an RFC 3339 UTC timestamp
 * with millisecond precision. `Date.prototype.toISOString` already emits
 * exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, which matches the schema pattern.
 */
export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw createError('MalformedInput', {
      message: 'The framework received a non-finite timestamp for a trace event.',
      field: 'timestamp',
    });
  }
  return new Date(epochMs).toISOString();
}

/**
 * Zero-pad a sequence number to exactly 10 digits for use in a filename.
 * Rejects negative or non-integer sequence numbers (the envelope allocator
 * guarantees non-negative integers, but the filename builder is defensive).
 */
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

/**
 * Validate a kebab-case role ID. Returns the role unchanged when valid;
 * throws `MalformedInput` otherwise. Rejecting here keeps an out-of-encoding
 * role from ever reaching a filename (where `..` or a separator could
 * otherwise enable traversal).
 */
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

/** Narrow an arbitrary string to one of the four allowed payload classes. */
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

/** Extension for a content type: `md` for text, `json` for structured. */
export function extensionFor(contentType: PayloadContentType): string {
  return contentType === 'structured' ? 'json' : 'md';
}

/**
 * Build the payload filename `<seq>-<role>-<class>.<ext>`. Every component is
 * validated before assembly so an adversarial role/class can never inject a
 * path separator or a `..` segment. The returned value is a bare filename
 * (no directory component).
 */
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

/**
 * Build the relative-POSIX payload reference stored on an `llmCall`/`toolCall`
 * event: `payloads/<filename>`. Always uses `/` separators and never has a
 * leading separator. The reference is re-validated against the same
 * path-escape rules as a final guard, so any future change to the filename
 * builder cannot silently produce a traversal-capable reference.
 */
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

/**
 * Reject any reference that escapes the trace root: an absolute path (leading
 * `/`), a `..` traversal segment, or a backslash (Windows-style separator the
 * POSIX-only reference contract forbids). Returns the reference unchanged when
 * it is confined.
 */
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

/**
 * Trace on-disk encoding rules — the canonical, security-checked vocabulary
 * for naming and referencing the files a trace writes.
 *
 * This module owns every rule about how a payload's identity is encoded into a
 * filename and a relative ref, plus the layout constants (directory names,
 * index filename) and the validators that reject malformed or path-escaping
 * inputs. Centralising it here means the emitter, store, and reconciler all
 * agree on the same byte-level layout.
 *
 * Shared guarantee: every name/ref this module returns is a confined relative
 * POSIX path safe to join under a trace root — the `assert*` helpers throw
 * before any caller can construct a path that escapes it.
 */

import { createError } from '../config-server/errors.js';

/**
 * The four payload roles a trace stores. `prompt`/`response` belong to LLM
 * calls; `arguments`/`result` belong to tool calls.
 */
export type PayloadClass = 'prompt' | 'response' | 'arguments' | 'result';

// Runtime allowlist mirroring PayloadClass, used by assertPayloadClass to
// validate untrusted strings without duplicating the literals at the call site.
const PAYLOAD_CLASSES: ReadonlySet<string> = new Set(['prompt', 'response', 'arguments', 'result']);

/**
 * Whether a payload body is plain text or structured JSON; selects the file
 * extension (`md` vs `json`) via {@link extensionFor}.
 */
export type PayloadContentType = 'text' | 'structured';

/** Directory (relative to a trace root) holding payload body files. */
export const PAYLOADS_DIRNAME = 'payloads';

/** Directory (relative to a trace root) holding per-event JSON files. */
export const EVENTS_DIRNAME = 'events';

/** Filename (relative to a trace root) of the rolling index summary. */
export const INDEX_FILENAME = 'index.json';

/**
 * Zero-pad width for sequence numbers in filenames. Fixed-width padding makes
 * lexical filename sort agree with numeric sequence order, so a plain
 * directory listing is already in event order.
 */
export const SEQ_PAD_WIDTH = 10;

// Role ids are kebab-case ASCII (lowercase alnum segments joined by single
// hyphens). Anchored to forbid leading/trailing/double hyphens so a role can
// never widen into a path separator or other filename metacharacter.
const ROLE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Convert an epoch-millisecond instant to an ISO-8601 UTC timestamp string for
 * a trace envelope.
 *
 * @param epochMs milliseconds since the Unix epoch.
 * @returns the ISO-8601 string (e.g. `2026-05-23T10:00:00.000Z`).
 * @throws `MalformedInput` when `epochMs` is not finite (NaN/Infinity), since a
 *   non-finite instant cannot produce a valid timestamp.
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
 * Render a sequence number as a fixed-width, zero-padded string for use in a
 * filename (see {@link SEQ_PAD_WIDTH} for why padding matters).
 *
 * @param sequenceNumber the event's sequence number.
 * @returns the number padded to {@link SEQ_PAD_WIDTH} digits.
 * @throws `MalformedInput` when `sequenceNumber` is not a non-negative integer.
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
 * Validate that `role` is a safe kebab-case ASCII role id and return it
 * unchanged. This is a security gate, not a formatter: roles flow into payload
 * filenames, so an invalid one could otherwise smuggle path separators.
 *
 * @param role the candidate role id.
 * @returns `role` unchanged when valid.
 * @throws `MalformedInput` when `role` is not a non-empty kebab-case ASCII
 *   identifier (see {@link ROLE_ID_PATTERN}).
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

/**
 * Validate that `cls` is one of the four known payload classes and narrow it
 * to {@link PayloadClass}.
 *
 * @param cls the candidate class string.
 * @returns `cls` narrowed to {@link PayloadClass} when valid.
 * @throws `MalformedInput` when `cls` is not one of `prompt`/`response`/
 *   `arguments`/`result`.
 */
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

/**
 * Map a content type to its payload-file extension: `structured` → `json`,
 * `text` → `md` (structured payloads are JSON; text payloads are stored as
 * Markdown for readable diffs).
 */
export function extensionFor(contentType: PayloadContentType): string {
  return contentType === 'structured' ? 'json' : 'md';
}

/**
 * Build the canonical payload filename `<seq>-<role>-<class>.<ext>`. Every
 * component is validated/normalised first, so the result is always a safe,
 * sortable filename.
 *
 * @param sequenceNumber owning event's sequence number (zero-padded).
 * @param role agent role; validated via {@link assertRoleId}.
 * @param cls payload class; validated via {@link assertPayloadClass}.
 * @param contentType selects the extension via {@link extensionFor}.
 * @returns the filename (no directory component).
 * @throws `MalformedInput` from the validators if any component is invalid.
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
 * Build the trace-root-relative reference for a payload:
 * `payloads/<seq>-<role>-<class>.<ext>`. This is the string stored on events
 * and later resolved against the trace root.
 *
 * @param sequenceNumber owning event's sequence number.
 * @param role agent role.
 * @param cls payload class.
 * @param contentType payload content type.
 * @returns the confined relative POSIX ref.
 * @throws `MalformedInput` from the filename builder on bad components;
 *   `PathEscape` from {@link assertSafeRelativeRef} (defence-in-depth — the
 *   constructed ref is re-checked even though its parts were already validated).
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
 * Reject any ref that is not a confined relative POSIX path under the trace
 * root, returning it unchanged when safe. Rejected: empty, absolute (leading
 * `/`), backslash-bearing (Windows separators), or containing a `..` segment.
 *
 * @param ref the candidate reference.
 * @returns `ref` unchanged when safe.
 * @throws `PathEscape` for any disallowed shape; callers rely on this to
 *   prevent a malicious or buggy ref from writing/reading outside the trace root.
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

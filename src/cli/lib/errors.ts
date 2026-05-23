

/**
 * Error rendering for the CLI, in both human and `--json` form.
 *
 * Any value can reach the top level as a thrown error — a structured
 * {@link ConfigServerError}, a plain `Error`, a pre-shaped error object, or
 * even a bare string. This module normalises all of them through a single
 * {@link coerce} step into a uniform {@link RenderableError}, then renders
 * that one shape, so the human and JSON outputs can never disagree about a
 * given error and an unexpected throw can never crash the renderer.
 */

import { ConfigServerError } from '../../config-server/errors.js';
import { emitJson } from './json-output.js';

/**
 * The normalised error shape both renderers consume.
 *
 * `code` and `message` are always present; the rest are optional context that
 * is only rendered when set. The open `[extra: string]` index signature lets a
 * `ConfigServerError.toJSON()` carry through additional structured fields into
 * the JSON output without this type having to enumerate them.
 *
 * @property code the stable error code (drives the exit code elsewhere).
 * @property message human-readable description.
 * @property file source file the error concerns, if any.
 * @property path config/filesystem path the error concerns, if any.
 * @property field the offending field, if any.
 * @property line 1-based line number within `file`, if known.
 * @property column 1-based column number within `file`, if known.
 * @property remediation a hint on how to fix the error, if available.
 */
export interface RenderableError {
  code: string;
  message: string;
  file?: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  remediation?: string;
  [extra: string]: unknown;
}

// Normalise any thrown value into a RenderableError. The order of the checks
// matters: a ConfigServerError carries the richest structured payload (via
// toJSON) and is tried first; an already-shaped error object is passed through
// as-is; a generic Error keeps only its message; and anything else (including
// a bare string) falls back to a NotImplemented placeholder so the renderer
// always has a code+message to print. Unrecognised throws map to
// NotImplemented rather than being swallowed silently.
function coerce(err: unknown): RenderableError {
  if (err instanceof ConfigServerError) {

    return err.toJSON() as unknown as RenderableError;
  }
  if (isF2Shape(err)) {
    return err;
  }
  if (err instanceof Error) {
    return {
      code: 'NotImplemented',
      message: err.message || 'unknown error',
    };
  }
  return {
    code: 'NotImplemented',
    message: typeof err === 'string' && err.length > 0 ? err : 'unknown error',
  };
}

// Structural test for an already-RenderableError-shaped value: a non-null
// object carrying string `code` and `message`. Lets coerce pass such objects
// through untouched instead of flattening them to NotImplemented.
function isF2Shape(v: unknown): v is RenderableError {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.code === 'string' && typeof r.message === 'string';
}

/**
 * Render any thrown value as the CLI's canonical JSON error payload.
 *
 * The value is first normalised via {@link coerce}, then `undefined`-valued
 * fields are dropped so the payload only carries present context, and the
 * result is emitted through {@link emitJson} for deterministic key ordering.
 *
 * @param err the thrown value (any type; normalised internally).
 * @returns the JSON string to write to stdout. Never throws.
 */
export function renderErrorJson(err: unknown): string {
  const shape = coerce(err);

  // Strip undefined fields so optional context (file/line/remediation/…) only
  // appears in the JSON when actually set, keeping the payload minimal.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (v !== undefined) out[k] = v;
  }
  return emitJson(out);
}

/**
 * Render any thrown value as the CLI's human-readable error block.
 *
 * Produces an `Error: <message>` line followed by indented context lines, each
 * emitted only when its field is present and non-empty. `file` and `path` are
 * mutually exclusive in the output — `file` wins when both are set, so the
 * more specific location is shown. The block is newline-terminated.
 *
 * @param err the thrown value (any type; normalised via {@link coerce}).
 * @returns the multi-line error text to write to stderr. Never throws.
 */
export function renderError(err: unknown): string {
  const shape = coerce(err);
  const lines: string[] = [];
  lines.push(`Error: ${shape.message}`);
  lines.push(`  code: ${shape.code}`);
  // file and path are alternatives, not both: prefer the more specific `file`
  // and fall back to `path` only when there is no file.
  if (typeof shape.file === 'string' && shape.file.length > 0) {
    lines.push(`  file: ${shape.file}`);
  } else if (typeof shape.path === 'string' && shape.path.length > 0) {
    lines.push(`  path: ${shape.path}`);
  }
  if (typeof shape.field === 'string' && shape.field.length > 0) {
    lines.push(`  field: ${shape.field}`);
  }
  if (typeof shape.line === 'number') {
    lines.push(`  line: ${shape.line}`);
  }
  if (typeof shape.remediation === 'string' && shape.remediation.length > 0) {
    lines.push(`  remediation: ${shape.remediation}`);
  }
  return lines.join('\n') + '\n';
}

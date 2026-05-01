/**
 * R3 sprint 2 — CLI error renderer.
 *
 * Two surfaces:
 *
 *   - `renderError(err)`     → human-readable text for stderr (no `--json`).
 *   - `renderErrorJson(err)` → deterministic JSON for stdout (with `--json`).
 *
 * Both handle the two error shapes the CLI ever receives:
 *
 *   1. `ConfigServerError` (R1's factory output) — has a structured `code`,
 *      `message`, and the optional context fields from F2's error model
 *      (`file`, `path`, `field`, `line`, `column`, `remediation`).
 *   2. Plain `Error` / unknown — wrapped as `{code:'NotImplemented', …}`
 *      so the JSON path always emits a valid F2 error object and the
 *      human path always has a non-empty message.
 *
 * The renderer NEVER constructs new `Error` instances inline (per the R1
 * error-factory rule — the only construction site is
 * `src/config-server/errors.ts`). It also obeys the F4 prose discipline:
 * no bare `npm`, `node`, `Node`, or `MCP server` tokens in any string this
 * file emits. The runtime backstop is `tests/cli/prose-discipline.test.ts`.
 */

import { ConfigServerError } from '../../config-server/errors.js';
import { emitJson } from './json-output.js';

/**
 * F2-shaped error object suitable for `--json` emission. Mirrors
 * `ConfigServerErrorShape`; we re-declare it here so callers don't have to
 * import from the framework's internal module to type their input.
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

/**
 * Coerce an arbitrary thrown value into a `RenderableError`. The renderer
 * itself never throws — every path must produce a stable shape so the
 * JSON surface stays parseable.
 */
function coerce(err: unknown): RenderableError {
  if (err instanceof ConfigServerError) {
    // `toJSON()` already produces an F2-shaped plain object.
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

function isF2Shape(v: unknown): v is RenderableError {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.code === 'string' && typeof r.message === 'string';
}

/**
 * Render an error as deterministic JSON suitable for stdout under `--json`.
 *
 * The output is the F2 error object verbatim, modulo the `emitJson` shape
 * rules (sorted keys, two-space indent, trailing newline).
 */
export function renderErrorJson(err: unknown): string {
  const shape = coerce(err);
  // Strip undefined entries so the output is stable across throw sites
  // that occasionally set `field` and sometimes don't.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (v !== undefined) out[k] = v;
  }
  return emitJson(out);
}

/**
 * Render an error as human-readable text suitable for stderr (no `--json`).
 *
 * Format:
 *   Error: <message>
 *     code: <code>
 *     file: <file>           (only if present)
 *     field: <field>         (only if present)
 *     remediation: <line>    (only if present)
 *
 * The output ends with a trailing newline. Prose-discipline violations
 * (bare `npm`/`node`/`Node`/`MCP server`) are forbidden in templates here.
 */
export function renderError(err: unknown): string {
  const shape = coerce(err);
  const lines: string[] = [];
  lines.push(`Error: ${shape.message}`);
  lines.push(`  code: ${shape.code}`);
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

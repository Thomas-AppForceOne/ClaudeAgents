/**
 * R3 sprint 2 — `gan config get <path> [--json] [--project-root DIR]`.
 *
 * Calls R1's `getResolvedConfig({projectRoot})` in-process; the dotted
 * path (e.g. `stacks.active`, `overlay.runner.thresholdOverride`) is
 * walked CLI-side via a simple split-and-reduce. The walker treats arrays
 * by numeric-string index (e.g. `stacks.active.0`) so callers can address
 * any leaf value reachable from the resolved config.
 *
 * Output:
 *   - `--json`: emit the value verbatim through `emitJson`. Even scalar
 *     values are valid JSON documents (a top-level string, number, or
 *     boolean is permitted by the F3 determinism contract).
 *   - human: print the value as JSON-encoded text (so booleans, numbers,
 *     and arrays round-trip cleanly), with a trailing newline. Strings
 *     are printed unquoted in the human form for ergonomics.
 *
 * Missing path / no value at the path → exit 1 with stderr "key not
 * found: <path>" (or the equivalent F2 error JSON under `--json`). Per
 * the contract this is a non-fatal "key not found" and uses generic
 * exit 1 rather than a validation/schema code.
 */

import { getResolvedConfig } from '../../index.js';
import { createError } from '../../config-server/errors.js';
import { emitJson } from '../lib/json-output.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { EXIT_BAD_ARGS, EXIT_GENERIC, EXIT_OK } from '../lib/exit-codes.js';
import { errorResult, readSharedFlags } from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import type { CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

const SENTINEL = Symbol('config-get-missing');

/** Walk a dotted path on a value. Returns SENTINEL when any segment is missing. */
function walk(root: unknown, dotted: string): unknown | typeof SENTINEL {
  if (dotted.length === 0) return root;
  const segments = dotted.split('.');
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return SENTINEL;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return SENTINEL;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor === 'object') {
      const obj = cursor as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) return SENTINEL;
      cursor = obj[seg];
      continue;
    }
    // Scalar mid-path — cannot descend further.
    return SENTINEL;
  }
  return cursor;
}

/** Render a value for the human (non-JSON) path. */
function renderHuman(value: unknown): string {
  if (typeof value === 'string') return value + '\n';
  if (value === undefined) return '\n';
  // Use stableStringify-equivalent via emitJson so nested objects look
  // identical to the `--json` form. Trailing newline already included.
  return emitJson(value);
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const dotted = parsed._[0];
  if (dotted === undefined || dotted.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan config get requires a dotted path argument (e.g. `stacks.active`).',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  let resolved: unknown;
  try {
    resolved = await getResolvedConfig({ projectRoot });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const value = walk(resolved, dotted);
  if (value === SENTINEL) {
    // "Key not found" is intentionally generic exit 1, not a validation
    // failure: the resolved config is fine; the caller asked for a path
    // that does not exist. We pass the renderer a plain F2-shaped object
    // (sentinel `code: 'KeyNotFound'`) rather than a thrown error — the
    // factory enum is closed and `KeyNotFound` is a CLI-only category.
    const shape = {
      code: 'KeyNotFound',
      message: `key not found: ${dotted}`,
      field: dotted,
    };
    if (wantJson) return { stdout: renderErrorJson(shape), stderr: '', code: EXIT_GENERIC };
    return { stdout: '', stderr: renderError(shape), code: EXIT_GENERIC };
  }

  const stdout = wantJson ? emitJson(value) : renderHuman(value);
  return { stdout, stderr: '', code: EXIT_OK };
}

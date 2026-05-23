/**
 * `gan config get <dotted.path>` — read a single value out of the fully
 * resolved config by a dotted path (e.g. `stacks.active`, `runner.0.name`).
 *
 * Read-only. A missing key is reported distinctly from a malformed invocation:
 * an absent/empty path argument is a bad-args error, while a well-formed path
 * that resolves to nothing is a `KeyNotFound`. The lookup is value-preserving —
 * the resolved value is printed verbatim (JSON in `--json` mode; strings bare,
 * everything else as JSON, in human mode).
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

// Unique sentinel distinguishing "key genuinely absent" from a real config
// value of `undefined`/`null` — a plain `undefined` return could not tell the
// two apart, and a stored `null` is a legitimate hit, not a miss.
const SENTINEL = Symbol('config-get-missing');

/**
 * Resolve a dotted path against an arbitrary config value.
 *
 * @param root the value to walk from (the resolved config object).
 * @param dotted the dotted path; an empty string returns `root` unchanged.
 * @returns the value at the path, or {@link SENTINEL} if any segment cannot be
 *   followed. Array segments must be valid in-range integer indices; object
 *   segments must be own properties; descending into a non-container (or
 *   null/undefined) yields the sentinel. Never throws.
 */
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

    return SENTINEL;
  }
  return cursor;
}

/**
 * Render a resolved value for human (non-JSON) output.
 *
 * @param value the value at the requested path.
 * @returns a string with a trailing newline. Strings are printed bare (not
 *   JSON-quoted) so scalar reads are pipe-friendly; `undefined` prints as a
 *   blank line; everything else is pretty-printed JSON.
 */
function renderHuman(value: unknown): string {
  if (typeof value === 'string') return value + '\n';
  if (value === undefined) return '\n';

  return emitJson(value);
}

/**
 * CLI entrypoint for `gan config get`.
 *
 * @param parsed parsed argv; the first positional is the required dotted path,
 *   and `--json` / `--project-root` are honoured via the shared helpers.
 * @returns a {@link CommandResult}. Failure modes are returned as data, never
 *   thrown:
 *   - missing/empty path argument → `MalformedInput`, exit {@link EXIT_BAD_ARGS};
 *   - project-root resolution or config load error → mapped via
 *     {@link errorResult};
 *   - well-formed path that does not resolve → `KeyNotFound`, exit
 *     {@link EXIT_GENERIC};
 *   - otherwise the value on `stdout`, exit {@link EXIT_OK}.
 */
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
    // Hand-built error shape (not createError): KeyNotFound is a soft, command-
    // specific miss rather than a config-server error code, and carries the
    // offending path in `field` for the renderer.
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

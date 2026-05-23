/**
 * `gan stack update <name> <dotted.path> <value>` — set a single field in a
 * named stack file.
 *
 * Always targets the project-tier copy of the stack (the write is reported
 * with `tier: 'project'`); the value argument is parsed from its CLI string
 * form by {@link parseCliValue}. The actual write is delegated to
 * {@link updateStackField}, which resolves the stack file and performs
 * validate-then-write, so a rejected mutation never touches disk.
 */

import { updateStackField } from '../../index.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { emitJson } from '../lib/json-output.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { renderWriteResult } from '../lib/output.js';
import { parseCliValue } from '../lib/value-parse.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_OK, exitCodeFor } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * CLI entrypoint for `gan stack update`.
 *
 * @param parsed parsed argv; positionals are the stack name, the dotted field
 *   path, and the raw value, with `--json` / `--project-root` honoured.
 * @returns a {@link CommandResult}. Failure modes are returned as data, never
 *   thrown:
 *   - any missing positional → `MalformedInput`, exit {@link EXIT_BAD_ARGS};
 *   - project-root resolution failure → mapped via {@link errorResult};
 *   - the write rejected with schema `issues` (or an unresolvable stack folded
 *     into issues) → first issue drives the error shape / {@link exitCodeFor};
 *   - a soft `reason` arm → a `NotImplemented` fallback;
 *   - a non-`ConfigServerError` throw → {@link unreachableResult}.
 *   On success, exit {@link EXIT_OK} with a confirmation on `stdout`.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];
  const fieldPath = parsed._[1];
  const rawValue = parsed._[2];

  if (name === undefined || name.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan stack update requires a stack name argument.',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }
  if (fieldPath === undefined || fieldPath.length === 0) {
    const err = createError('MalformedInput', {
      message:
        'gan stack update requires a field path argument (e.g. `gan stack update generic lintCmd "vitest run"`).',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }
  if (rawValue === undefined) {
    const err = createError('MalformedInput', {
      message: 'gan stack update requires a value argument.',
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

  // Interpret the raw CLI string into its typed value before the write.
  const value = parseCliValue(rawValue);

  let result;
  try {
    result = updateStackField({ projectRoot, name, fieldPath, value });
  } catch (e) {
    // Expected ConfigServerError → mapped; anything else → library unreachable.
    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  if (result.mutated === true) {
    if (wantJson) {
      const stdout = emitJson({
        name,
        path: fieldPath,
        tier: 'project',
        value,
        written: true,
      });
      return { stdout, stderr: '', code: EXIT_OK };
    }
    return {
      stdout: renderWriteResult({ tier: 'project', name, path: fieldPath, value }),
      stderr: '',
      code: EXIT_OK,
    };
  }

  if ('issues' in result) {
    // First issue drives the exit code; the full list is attached for detail.
    const first = result.issues[0];
    const code = exitCodeFor(first?.code);
    const shape = first
      ? {
          code: first.code,
          message: first.message,
          ...(first.path !== undefined ? { file: first.path } : {}),
          ...(first.field !== undefined ? { field: first.field } : {}),
          issues: result.issues,
        }
      : {
          code: 'ValidationFailed',
          message: 'gan stack update: write rejected with no issue details.',
        };
    if (wantJson) return { stdout: renderErrorJson(shape), stderr: '', code };
    return { stdout: '', stderr: renderError(shape), code };
  }

  // Defensive fallback: no stack-update path returns a soft `reason` today, so
  // reaching here surfaces the unexpected reason rather than claiming success.
  const fallback = createError('NotImplemented', {
    message: `gan stack update: write was rejected (reason: ${result.reason}).`,
  });
  if (wantJson)
    return { stdout: renderErrorJson(fallback), stderr: '', code: exitCodeFor(fallback.code) };
  return { stdout: '', stderr: renderError(fallback), code: exitCodeFor(fallback.code) };
}

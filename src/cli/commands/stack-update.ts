/**
 * R3 sprint 3 — `gan stack update <name> <field> <value> [--json] [--project-root DIR]`.
 *
 * Calls R1's `updateStackField({projectRoot, name, fieldPath, value})` in-
 * process. Stack writes have a different tier model than overlay writes
 * (per C5): the writes layer always lands the mutation on the resolved
 * stack file, which for the canonical update flow is the project-tier
 * shadow at `.claude/gan/stacks/<name>.md`. The CLI does not expose
 * `--tier` for `stack update`; doing so would invite users to attempt
 * built-in-tier writes (forbidden — repo-tier stacks are mutated by their
 * owners, not by the CLI).
 *
 * Value parsing follows `parseCliValue`: try JSON literal first, fall
 * back to the bare string. Same semantics as `gan config set`.
 *
 * Output:
 *   - human: `Updated <field> on stack <name> to <value>.` (stdout, exit 0)
 *   - JSON:  `{"name": "...", "path": "...", "tier": "project", "value": ..., "written": true}`
 *
 * Errors:
 *   - missing args                 → MalformedInput, exit 64.
 *   - unknown stack / missing file → MissingFile from R1, exit 2.
 *   - schema rejection             → first issue code maps via exitCodeFor.
 *   - library unreachable          → exit 5 with install.sh hint.
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

  const value = parseCliValue(rawValue);

  let result;
  try {
    result = updateStackField({ projectRoot, name, fieldPath, value });
  } catch (e) {
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

  const fallback = createError('NotImplemented', {
    message: `gan stack update: write was rejected (reason: ${result.reason}).`,
  });
  if (wantJson)
    return { stdout: renderErrorJson(fallback), stderr: '', code: exitCodeFor(fallback.code) };
  return { stdout: '', stderr: renderError(fallback), code: exitCodeFor(fallback.code) };
}

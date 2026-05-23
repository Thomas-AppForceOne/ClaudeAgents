

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

function renderHuman(value: unknown): string {
  if (typeof value === 'string') return value + '\n';
  if (value === undefined) return '\n';

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

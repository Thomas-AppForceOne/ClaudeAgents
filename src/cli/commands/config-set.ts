

import { setOverlayField } from '../../index.js';
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
import type { OverlayTier } from '../../index.js';
import type { ParsedArgs } from '../lib/args.js';

type WritableOverlayTier = Extract<OverlayTier, 'project' | 'user'>;

const ALLOWED_TIERS: ReadonlySet<WritableOverlayTier> = new Set<WritableOverlayTier>([
  'project',
  'user',
]);

function readTier(parsed: ParsedArgs): WritableOverlayTier | ConfigServerError {
  const raw = parsed.flags['tier'];
  if (raw === undefined || raw === false) return 'project';
  if (raw === true) {
    return createError('MalformedInput', {
      field: '--tier',
      message: '--tier requires a value (`project` or `user`).',
    });
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return createError('MalformedInput', {
      field: '--tier',
      message: '--tier requires a value (`project` or `user`).',
    });
  }
  if (!ALLOWED_TIERS.has(raw as WritableOverlayTier)) {
    return createError('MalformedInput', {
      field: '--tier',
      message: `--tier must be 'project' or 'user' (got '${raw}'). The 'default' tier is read-only and 'repo' is not an overlay tier.`,
    });
  }
  return raw as WritableOverlayTier;
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const fieldPath = parsed._[0];
  const rawValue = parsed._[1];
  if (fieldPath === undefined || fieldPath.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan config set requires a dotted path argument (e.g. `runner.thresholdOverride`).',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }
  if (rawValue === undefined) {
    const err = createError('MalformedInput', {
      message:
        'gan config set requires a value argument (e.g. `gan config set runner.thresholdOverride 8`).',
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(err), code: EXIT_BAD_ARGS };
  }

  const tier = readTier(parsed);
  if (tier instanceof ConfigServerError) {
    if (wantJson) return { stdout: renderErrorJson(tier), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(tier), code: EXIT_BAD_ARGS };
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
    result = setOverlayField({ projectRoot, tier, fieldPath, value });
  } catch (e) {

    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  if (result.mutated === true) {
    if (wantJson) {
      const stdout = emitJson({
        path: fieldPath,
        tier,
        value,
        written: true,
      });
      return { stdout, stderr: '', code: EXIT_OK };
    }
    return {
      stdout: renderWriteResult({ tier, path: fieldPath, value }),
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
          message: 'gan config set: write rejected with no issue details.',
        };
    if (wantJson) return { stdout: renderErrorJson(shape), stderr: '', code };
    return { stdout: '', stderr: renderError(shape), code };
  }

  const fallback = createError('NotImplemented', {
    message: `gan config set: write was rejected (reason: ${result.reason}).`,
  });
  if (wantJson)
    return { stdout: renderErrorJson(fallback), stderr: '', code: exitCodeFor(fallback.code) };
  return { stdout: '', stderr: renderError(fallback), code: exitCodeFor(fallback.code) };
}

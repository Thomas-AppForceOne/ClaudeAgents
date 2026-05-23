/**
 * `gan config set <dotted.path> <value>` — set a single overlay field.
 *
 * Writes to the `project` overlay by default, or the `user` overlay with
 * `--tier`. The `default` tier is read-only and `repo` is not an overlay tier,
 * so only `project`/`user` are accepted. The value argument is parsed from its
 * CLI string form (numbers/booleans/JSON) by {@link parseCliValue} before being
 * written. This delegates the actual write to {@link setOverlayField}, which
 * performs validate-then-write and never leaves a partial overlay on disk.
 */

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

// The overlay tiers this command may write: `default` is read-only and `repo`
// is not an overlay tier, so they are excluded at the type level.
type WritableOverlayTier = Extract<OverlayTier, 'project' | 'user'>;

// Single source of truth for the writable tier strings, used by readTier to
// validate the untrusted --tier value without re-listing the literals.
const ALLOWED_TIERS: ReadonlySet<WritableOverlayTier> = new Set<WritableOverlayTier>([
  'project',
  'user',
]);

/**
 * Resolve the target overlay tier from the `--tier` flag.
 *
 * @param parsed parsed argv.
 * @returns the chosen {@link WritableOverlayTier} (defaulting to `project` when
 *   the flag is absent), or a `MalformedInput` {@link ConfigServerError} —
 *   returned, not thrown — when the flag is present-but-valueless or names a
 *   tier outside the writable set.
 */
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

/**
 * CLI entrypoint for `gan config set`.
 *
 * @param parsed parsed argv; positionals are the dotted field path and the
 *   raw value, with `--tier`, `--json`, and `--project-root` honoured.
 * @returns a {@link CommandResult}. Failure modes are returned as data, never
 *   thrown:
 *   - missing path or value, or a bad `--tier` → `MalformedInput`, exit
 *     {@link EXIT_BAD_ARGS};
 *   - project-root resolution failure → mapped via {@link errorResult};
 *   - the write rejected with schema `issues` → the first issue drives the
 *     error shape and {@link exitCodeFor} the exit code;
 *   - a write that returns a soft `reason` (no overlay path does today) →
 *     surfaced as a `NotImplemented` fallback;
 *   - a non-`ConfigServerError` thrown by the write → {@link unreachableResult}.
 *   On success, exit {@link EXIT_OK} with a confirmation on `stdout`.
 */
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

  // Interpret the raw CLI string (e.g. `8` → number, `true` → boolean, JSON
  // literals) before handing it to the typed overlay write.
  const value = parseCliValue(rawValue);

  let result;
  try {
    result = setOverlayField({ projectRoot, tier, fieldPath, value });
  } catch (e) {
    // setOverlayField returns soft failures as data; a throw here is either an
    // expected ConfigServerError (mapped) or an unexpected fault (treated as
    // the library being unreachable).
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
    // Report against the first issue (its code drives the exit code) while
    // still attaching the full issue list for callers that want detail.
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

  // Reached only if the write returns a soft `reason` arm. No overlay write
  // path produces one today, so this is a defensive fallback that surfaces the
  // unexpected reason rather than silently succeeding.
  const fallback = createError('NotImplemented', {
    message: `gan config set: write was rejected (reason: ${result.reason}).`,
  });
  if (wantJson)
    return { stdout: renderErrorJson(fallback), stderr: '', code: exitCodeFor(fallback.code) };
  return { stdout: '', stderr: renderError(fallback), code: exitCodeFor(fallback.code) };
}

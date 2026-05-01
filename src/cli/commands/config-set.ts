/**
 * R3 sprint 3 — `gan config set <path> <value> [--tier=project|user] [--json] [--project-root DIR]`.
 *
 * Calls R1's `setOverlayField({projectRoot, tier, fieldPath, value})` in-
 * process (per the CLI-imports-library rule). The CLI only validates the
 * `--tier` flag locally; everything else (path well-formedness, schema
 * compliance, atomic write) is the writes layer's job.
 *
 * Tier validation:
 *   - default tier: `project`.
 *   - allowed: `project`, `user`.
 *   - explicitly rejected (exit 64): `repo`, `default`, anything else.
 *     Per C3, the overlay cascade has three tiers — `default`, `user`,
 *     `project` — but the writable surface is `user` and `project` only;
 *     `default` is the agent's bare default and is never user-writable.
 *
 * Value parsing follows `parseCliValue`: try JSON literal first, fall
 * back to the bare string on parse error. So `gan config set foo.bar 8`
 * writes the number 8, `gan config set foo.bar true` writes a boolean,
 * `gan config set foo.bar hello` writes the string `"hello"`.
 *
 * Output:
 *   - human: `Updated <path> to <value> in <tier> overlay.` (stdout, exit 0)
 *   - JSON:  `{"path": "...", "tier": "...", "value": ..., "written": true}`
 *
 * Errors:
 *   - missing args / invalid tier → MalformedInput, exit 64.
 *   - write returns issues       → first issue's code maps via exitCodeFor;
 *                                   typically exit 2 (ValidationFailed) or 4.
 *   - write throws ConfigServerError → mapped via exitCodeFor.
 *   - anything else (library unreachable) → exit 5 with install.sh hint.
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

/** Allowed tier values for `gan config set`. */
type WritableOverlayTier = Extract<OverlayTier, 'project' | 'user'>;

const ALLOWED_TIERS: ReadonlySet<WritableOverlayTier> = new Set<WritableOverlayTier>([
  'project',
  'user',
]);

/**
 * Read and validate `--tier`. Returns the resolved tier (default `project`)
 * or a `ConfigServerError` describing the validation failure.
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
    // Library throwing here (rather than returning issues) is a hard
    // error path — typically the framework library being absent. Fall
    // through to the unreachable surface.
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

  // mutation rejected. Two shapes possible:
  //   { mutated: false, issues: Issue[] }
  //   { mutated: false, reason: string }
  // The first is the validation-failed branch; the second is reserved for
  // trust loud-stub responses (not reachable from setOverlayField in R1)
  // but kept for forward-compatibility.
  if ('issues' in result) {
    // Use the first issue's code for the exit code; render every issue
    // so the user sees the full picture.
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

  // `reason` branch — surface as a generic failure.
  const fallback = createError('NotImplemented', {
    message: `gan config set: write was rejected (reason: ${result.reason}).`,
  });
  if (wantJson)
    return { stdout: renderErrorJson(fallback), stderr: '', code: exitCodeFor(fallback.code) };
  return { stdout: '', stderr: renderError(fallback), code: exitCodeFor(fallback.code) };
}

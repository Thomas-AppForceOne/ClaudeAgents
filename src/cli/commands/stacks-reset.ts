/**
 * `gan stacks reset <name>` — drop a stack customization, restoring the
 * framework's built-in default for that stack.
 *
 * It deletes the tier-specific customization file (`project` by default,
 * `user` with `--tier`). Resetting a stack that has no customization is a
 * benign no-op: it exits OK with a `stderr` warning and `deleted: false`,
 * never an error — so this command is safe to run idempotently.
 */

import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { ConfigServerError, createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { resolveUserHome } from '../lib/user-home.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

// The tiers a customization may live in (and thus be reset from).
type ResetTier = 'project' | 'user';

const ALLOWED_TIERS: ReadonlySet<ResetTier> = new Set<ResetTier>(['project', 'user']);

/**
 * Resolve the target tier from the `--tier` flag.
 *
 * @param parsed parsed argv.
 * @returns the chosen {@link ResetTier} (default `project`), or a
 *   `MalformedInput` {@link ConfigServerError} — returned, not thrown — when
 *   `--tier` is present without a value or names an unsupported tier.
 */
function readTier(parsed: ParsedArgs): ResetTier | ConfigServerError {
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
  if (!ALLOWED_TIERS.has(raw as ResetTier)) {
    return createError('MalformedInput', {
      field: '--tier',
      message: `--tier must be 'project' or 'user' for gan stacks reset (got '${raw}').`,
    });
  }
  return raw as ResetTier;
}

/**
 * Compute the absolute path of the customization file to delete.
 *
 * @param tier which tier's customization to target.
 * @param name the stack name.
 * @param projectRoot the resolved project root (used for the `project` tier).
 * @param userHome the resolved user home, or `null` if none (only consulted
 *   for the `user` tier).
 * @returns the `<root>/.claude/gan/stacks/<name>.md` path, or a
 *   `MalformedInput` {@link ConfigServerError} for `--tier=user` with no home.
 */
function targetPathFor(
  tier: ResetTier,
  name: string,
  projectRoot: string,
  userHome: string | null,
): string | ConfigServerError {
  if (tier === 'project') {
    return path.join(projectRoot, '.claude', 'gan', 'stacks', `${name}.md`);
  }
  if (userHome === null) {
    return createError('MalformedInput', {
      message:
        'gan stacks reset --tier=user requires a user home directory. Set the HOME environment variable and re-run.',
    });
  }
  return path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`);
}

/**
 * Render the success notice for human (non-JSON) output, confirming the
 * built-in default is back in effect.
 */
function renderHumanSuccess(name: string, tier: ResetTier, target: string): string {
  return [
    `Reset stack '${name}' at ${target} (tier: ${tier}).`,
    "The framework's built-in default is now active.",
    '',
  ].join('\n');
}

/**
 * CLI entrypoint for `gan stacks reset`.
 *
 * @param parsed parsed argv; the first positional is the required stack name,
 *   with `--tier`, `--json`, and `--project-root` honoured.
 * @returns a {@link CommandResult}. Failure modes are returned as data:
 *   - missing name or bad `--tier` → `MalformedInput`, exit {@link EXIT_BAD_ARGS};
 *   - `--tier=user` with no home → `MalformedInput`, exit {@link EXIT_BAD_ARGS};
 *   - project-root resolution failure → mapped via {@link errorResult};
 *   - an unlink failure → {@link unreachableResult}.
 *   When no customization exists the result is a *successful* no-op
 *   (exit {@link EXIT_OK}, `deleted: false`, warning on `stderr`). Side effect
 *   on a real reset: deletes the customization file.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];
  if (name === undefined || name.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan stacks reset requires a stack name argument.',
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
  let projectRootDisplay: string;
  try {
    const resolved = resolveProjectRoot(rootFlag);
    projectRoot = resolved.path;
    projectRootDisplay = resolved.displayPath;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const userHome = resolveUserHome();
  const targetOrErr = targetPathFor(tier, name, projectRoot, userHome);
  if (targetOrErr instanceof ConfigServerError) {
    if (wantJson) return { stdout: renderErrorJson(targetOrErr), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(targetOrErr), code: EXIT_BAD_ARGS };
  }
  const target = targetOrErr;

  // Present the target under the project root's display form when the canonical
  // and display roots differ, so the path matches what the user typed.
  const targetDisplay =
    projectRoot !== projectRootDisplay && target.startsWith(projectRoot)
      ? projectRootDisplay + target.slice(projectRoot.length)
      : target;

  // No customization to remove: a benign, idempotent no-op — exit OK with a
  // warning, not an error.
  if (!existsSync(target)) {
    const warning = `warning: no customization at ${targetDisplay} for stack '${name}' (tier: ${tier})\n`;
    if (wantJson) {
      return {
        stdout: emitJson({
          deleted: false,
          name,
          path: targetDisplay,
          reason: 'no-customization',
          tier,
        }),
        stderr: warning,
        code: EXIT_OK,
      };
    }
    return { stdout: '', stderr: warning, code: EXIT_OK };
  }

  try {
    unlinkSync(target);
  } catch {
    return unreachableResult(wantJson);
  }

  if (wantJson) {
    return {
      stdout: emitJson({ deleted: true, name, path: targetDisplay, tier }),
      stderr: '',
      code: EXIT_OK,
    };
  }
  return { stdout: renderHumanSuccess(name, tier, targetDisplay), stderr: '', code: EXIT_OK };
}

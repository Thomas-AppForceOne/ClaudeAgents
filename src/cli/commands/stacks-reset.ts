/**
 * R-post sprint 6 — `gan stacks reset <name> [--tier=project|user]`.
 *
 * Drops a customisation copy at the named tier so the framework's built-in
 * default re-wins resolution (per C5's tier ordering).
 *
 * Idempotent: if the customisation does not exist at the chosen tier, the
 * command emits a one-line warning to stderr and exits 0. The shape of
 * "nothing to do" is reported in the JSON surface (`deleted: false,
 * reason: 'no-customization'`) so scripted callers can distinguish the
 * two cases without parsing exit codes.
 *
 * Tiers:
 *   - `--tier=project` (default) → `<projectRoot>/.claude/gan/stacks/<name>.md`
 *   - `--tier=user`              → `<userHome>/.claude/gan/stacks/<name>.md`
 *
 * Exit codes:
 *   - 0 on success or no-op;
 *   - 64 on bad CLI arguments (missing name, invalid `--tier`, missing user
 *     home for `--tier=user`).
 */

import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { ConfigServerError, createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

type ResetTier = 'project' | 'user';

const ALLOWED_TIERS: ReadonlySet<ResetTier> = new Set<ResetTier>(['project', 'user']);

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

function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

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

function renderHumanSuccess(name: string, tier: ResetTier, target: string): string {
  return [
    `Reset stack '${name}' at ${target} (tier: ${tier}).`,
    "The framework's built-in default is now active.",
    '',
  ].join('\n');
}

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
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
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

  if (!existsSync(target)) {
    const warning = `warning: no customization at ${target} for stack '${name}' (tier: ${tier})\n`;
    if (wantJson) {
      return {
        stdout: emitJson({ deleted: false, name, path: target, reason: 'no-customization', tier }),
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
      stdout: emitJson({ deleted: true, name, path: target, tier }),
      stderr: '',
      code: EXIT_OK,
    };
  }
  return { stdout: renderHumanSuccess(name, tier, target), stderr: '', code: EXIT_OK };
}

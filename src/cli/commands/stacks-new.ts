

import { existsSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { buildScaffold, type ScaffoldTier } from '../lib/scaffold.js';
import { resolveUserHome } from '../lib/user-home.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_GENERIC, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

const ALLOWED_TIERS: ReadonlySet<ScaffoldTier> = new Set<ScaffoldTier>([
  'project',
  'user',
]);

function readTier(parsed: ParsedArgs): ScaffoldTier | ConfigServerError {
  const raw = parsed.flags['tier'];
  if (raw === undefined || raw === false) return 'project';
  if (raw === true) {

    return createError('MalformedInput', {
      field: '--tier',
      message: "--tier requires a value: 'project' or 'user'.",
    });
  }
  if (typeof raw !== 'string' || raw.length === 0) {

    return createError('MalformedInput', {
      field: '--tier',
      message: "--tier must be 'project' or 'user' (got '').",
    });
  }
  if (!ALLOWED_TIERS.has(raw as ScaffoldTier)) {
    return createError('MalformedInput', {
      field: '--tier',
      message: `--tier must be 'project' or 'user' (got '${raw}').`,
    });
  }
  return raw as ScaffoldTier;
}

function targetPathFor(
  projectRoot: string,
  tier: ScaffoldTier,
  name: string,
): string | ConfigServerError {
  if (tier === 'project') {
    return path.join(projectRoot, '.claude', 'gan', 'stacks', `${name}.md`);
  }
  const userHome = resolveUserHome();
  if (userHome === null) {
    return createError('MalformedInput', {
      message:
        'gan stacks new --tier=user requires a user home directory. Set the HOME environment variable and re-run.',
    });
  }
  return path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`);
}

function renderHumanSuccess(name: string, tier: ScaffoldTier, target: string): string {
  return [
    `Scaffolded stack \`${name}\` at ${target} (tier: ${tier}).`,
    'Replace the TODOs and remove the DRAFT banner before committing.',
    '',
  ].join('\n');
}

function renderJsonSuccess(name: string, tier: ScaffoldTier, target: string): string {
  return emitJson({ name, tier, path: target, written: true });
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];
  if (name === undefined || name.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan stacks new requires a stack name argument.',
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

  const target = targetPathFor(projectRoot, tier, name);
  if (target instanceof ConfigServerError) {
    if (wantJson) return { stdout: renderErrorJson(target), stderr: '', code: EXIT_BAD_ARGS };
    return { stdout: '', stderr: renderError(target), code: EXIT_BAD_ARGS };
  }

  if (existsSync(target)) {
    const err = createError('MalformedInput', {
      file: target,
      message: `gan stacks new refuses to overwrite '${target}'. Delete the file first if you want a fresh scaffold.`,
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_GENERIC };
    return { stdout: '', stderr: renderError(err), code: EXIT_GENERIC };
  }

  const body = buildScaffold(name, tier);
  try {
    atomicWriteFile(target, body);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  const stdout = wantJson
    ? renderJsonSuccess(name, tier, target)
    : renderHumanSuccess(name, tier, target);
  return { stdout, stderr: '', code: EXIT_OK };
}

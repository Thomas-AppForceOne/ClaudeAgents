/**
 * R-post sprint 6 — `gan stacks customize <name> [--tier=project|user] [--force]`.
 *
 * Copies a built-in stack file (`<packageRoot>/stacks/<name>.md`) into a
 * customisation tier so the user can edit it. Source is always the
 * built-in file directly; we deliberately do NOT route through
 * `getStackResolution` because resolution would prefer an existing
 * higher-tier copy — the customisation flow wants the framework's
 * default as the seed, even if a stale customisation already exists.
 *
 * Tiers:
 *   - `--tier=project` (default) → `<projectRoot>/.claude/gan/stacks/<name>.md`
 *   - `--tier=user`              → `<userHome>/.claude/gan/stacks/<name>.md`
 *
 * Refuses overwrite without `--force`. With `--force`, the existing copy
 * is replaced atomically via `atomicWriteFile`.
 *
 * Exit codes (per `lib/exit-codes.ts`):
 *   - 0 on success;
 *   - 1 (generic) on overwrite refusal (matches `gan stacks new` semantics);
 *   - 2 (validation) when the source built-in file is missing;
 *   - 64 on bad CLI arguments (missing name, invalid `--tier`, missing user
 *     home for `--tier=user`).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { packageRoot as resolvePackageRoot } from '../../config-server/package-root.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_GENERIC, EXIT_OK, exitCodeFor } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

type CustomizeTier = 'project' | 'user';

const ALLOWED_TIERS: ReadonlySet<CustomizeTier> = new Set<CustomizeTier>(['project', 'user']);

/**
 * @internal test-only env var: `GAN_PACKAGE_ROOT_OVERRIDE`. Lets tests
 *   stage a tmp directory containing a built-in `stacks/` tree.
 */
function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

function readTier(parsed: ParsedArgs): CustomizeTier | ConfigServerError {
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
  if (!ALLOWED_TIERS.has(raw as CustomizeTier)) {
    return createError('MalformedInput', {
      field: '--tier',
      message: `--tier must be 'project' or 'user' for gan stacks customize (got '${raw}').`,
    });
  }
  return raw as CustomizeTier;
}

function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function targetPathFor(
  tier: CustomizeTier,
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
        'gan stacks customize --tier=user requires a user home directory. Set the HOME environment variable and re-run.',
    });
  }
  return path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`);
}

function renderHumanSuccess(name: string, tier: CustomizeTier, target: string): string {
  return [
    `Customized stack '${name}' at ${target} (tier: ${tier}).`,
    `Edit the file to override the framework's defaults; run \`gan stacks reset ${name}\` to drop the customization.`,
    '',
  ].join('\n');
}

function renderJsonSuccess(
  name: string,
  tier: CustomizeTier,
  target: string,
  source: string,
  forced: boolean,
): string {
  return emitJson({ forced, name, path: target, source, tier, written: true });
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);
  const force = parsed.flags['force'] === true;

  const name = parsed._[0];
  if (name === undefined || name.length === 0) {
    const err = createError('MalformedInput', {
      message: 'gan stacks customize requires a stack name argument.',
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

  let stacksDir: string;
  try {
    stacksDir = resolveBuiltinStacksDir();
  } catch (e) {
    const err =
      e instanceof ConfigServerError
        ? e
        : createError('MissingFile', {
            message: `the framework could not locate its built-in stacks directory: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: exitCodeFor(err.code) };
    return { stdout: '', stderr: renderError(err), code: exitCodeFor(err.code) };
  }

  const source = path.join(stacksDir, `${name}.md`);
  if (!existsSync(source)) {
    const err = createError('MissingFile', {
      file: source,
      message: `built-in stack '${name}' not found at ${source}. Run \`gan stacks available\` to see the list of built-in stacks.`,
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: exitCodeFor(err.code) };
    return { stdout: '', stderr: renderError(err), code: exitCodeFor(err.code) };
  }

  if (existsSync(target) && !force) {
    const err = createError('MalformedInput', {
      file: target,
      message: `gan stacks customize refuses to overwrite '${target}'. Pass --force to replace the existing customization, or delete the file first.`,
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: EXIT_GENERIC };
    return { stdout: '', stderr: renderError(err), code: EXIT_GENERIC };
  }

  let body: string;
  try {
    body = readFileSync(source, 'utf8');
  } catch {
    return unreachableResult(wantJson);
  }

  try {
    atomicWriteFile(target, body);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  const stdout = wantJson
    ? renderJsonSuccess(name, tier, target, source, force)
    : renderHumanSuccess(name, tier, target);
  return { stdout, stderr: '', code: EXIT_OK };
}

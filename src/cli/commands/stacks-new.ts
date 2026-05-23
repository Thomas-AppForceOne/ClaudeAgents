/**
 * `gan stacks new <name>` — scaffold a brand-new stack file from a template.
 *
 * Writes a DRAFT scaffold (TODO placeholders) into the project tier by default
 * or the user tier with `--tier`. It refuses to clobber an existing file: an
 * occupied target is an error, not an overwrite, so the user must delete it
 * first. Compare {@link buildScaffold} (fresh template) with `gan stacks
 * customize`, which instead copies a built-in stack's real body.
 */

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

// The tiers a scaffold may be written to; `--tier` is validated against this.
const ALLOWED_TIERS: ReadonlySet<ScaffoldTier> = new Set<ScaffoldTier>([
  'project',
  'user',
]);

/**
 * Resolve the target tier from the `--tier` flag.
 *
 * @param parsed parsed argv.
 * @returns the chosen {@link ScaffoldTier} (default `project`), or a
 *   `MalformedInput` {@link ConfigServerError} — returned, not thrown — when
 *   `--tier` is present without a value or names an unsupported tier.
 */
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

/**
 * Compute the absolute target path for the new stack file.
 *
 * @param projectRoot the resolved project root (used for the `project` tier).
 * @param tier which tier the file belongs to.
 * @param name the stack name (becomes `<name>.md`).
 * @returns the `<root>/.claude/gan/stacks/<name>.md` path, or a
 *   `MalformedInput` {@link ConfigServerError} when `tier` is `user` but no
 *   user home can be resolved.
 */
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

/**
 * Render the success notice for human (non-JSON) output, including the
 * reminder to fill in the scaffold before committing.
 */
function renderHumanSuccess(name: string, tier: ScaffoldTier, target: string): string {
  return [
    `Scaffolded stack \`${name}\` at ${target} (tier: ${tier}).`,
    'Replace the TODOs and remove the DRAFT banner before committing.',
    '',
  ].join('\n');
}

/**
 * Render the success payload for `--json` output (`written: true` plus the
 * name, tier, and target path).
 */
function renderJsonSuccess(name: string, tier: ScaffoldTier, target: string): string {
  return emitJson({ name, tier, path: target, written: true });
}

/**
 * CLI entrypoint for `gan stacks new`.
 *
 * @param parsed parsed argv; the first positional is the required stack name,
 *   with `--tier`, `--json`, and `--project-root` honoured.
 * @returns a {@link CommandResult}. Failure modes are returned as data:
 *   - missing name or bad `--tier` → `MalformedInput`, exit {@link EXIT_BAD_ARGS};
 *   - `--tier=user` with no resolvable home → `MalformedInput`, exit
 *     {@link EXIT_BAD_ARGS};
 *   - project-root resolution failure → mapped via {@link errorResult};
 *   - target already exists → refusal to overwrite, exit {@link EXIT_GENERIC};
 *   - a write throw → {@link errorResult} (ConfigServerError) or
 *     {@link unreachableResult}.
 *   Side effect on success: atomically writes the scaffold file; exit
 *   {@link EXIT_OK}.
 */
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

  // Never clobber: an existing target is a refusal, so the user can't lose an
  // edited stack to a stray `stacks new`.
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

/**
 * R3 sprint 4 — `gan stacks new <name> [--tier=project] [--project-root DIR]`.
 *
 * Scaffolds a DRAFT-bannered stack file. `--tier=project` (the default)
 * writes to `<root>/.claude/gan/stacks/<name>.md`; `--tier=user` writes to
 * `<userHome>/.claude/gan/stacks/<name>.md` (the user-tier path per C5).
 * Any other value — including the legacy `repo`, `builtin`, or unknown
 * strings — exits 64 with a structured `MalformedInput` error whose
 * message names both supported values. There is no end-user-facing
 * builtin/repo scaffold target: built-in stacks ship inside the published
 * npm package and are surfaced via `gan stacks customize`.
 *
 * Refuses to overwrite an existing file (the scaffold-no-overwrite rule):
 * exits 1 with a clear stderr message naming the absolute path. The CLI
 * never exposes a `--force` flag in v1.
 *
 * Persistence flows through R1's `atomicWriteFile` so the write is
 * atomic-by-rename. Bytes written equal `buildScaffold(name, tier)`
 * byte-for-byte; tests assert that property.
 *
 * Exit codes flow through `lib/exit-codes.ts`; no numeric literals here.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { buildScaffold, type ScaffoldTier } from '../lib/scaffold.js';
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

/**
 * Read and validate `--tier`. Returns the resolved tier (default `project`)
 * or a `ConfigServerError` describing the failure (rendered as exit 64).
 *
 * Both `project` and `user` are supported (R6 slice 2). Any other value —
 * including the legacy/deprecated `repo`/`builtin` tiers and unknown
 * strings, as well as the value-less / bare-boolean forms of `--tier` —
 * flows through the same `MalformedInput` rejection path, whose message
 * names BOTH supported values. There is no end-user-facing builtin/repo
 * scaffold target: built-in stacks ship inside the npm package (per E2's
 * distribution model) and are surfaced via `gan stacks customize`.
 */
function readTier(parsed: ParsedArgs): ScaffoldTier | ConfigServerError {
  const raw = parsed.flags['tier'];
  if (raw === undefined || raw === false) return 'project';
  if (raw === true) {
    return createError('MalformedInput', {
      field: '--tier',
      message: "--tier must be 'project' or 'user' (got '').",
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
 * Resolve the user home directory using the same convention the rest of
 * the CLI uses for user-tier paths (see `stacks-customize` / `stacks-reset`):
 * `GAN_USER_HOME` (test injection) → `HOME` → `USERPROFILE`.
 */
function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Resolve the absolute target path for the named stack at the given tier.
 * Project tier resolves under `projectRoot`; user tier resolves under the
 * user home `.claude/gan/stacks` directory (C5 user-tier path), independent
 * of `--project-root`.
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

function renderHumanSuccess(name: string, tier: ScaffoldTier, target: string): string {
  return [
    `Scaffolded stack \`${name}\` at ${target} (tier: ${tier}).`,
    'Replace the TODOs and remove the DRAFT banner before committing.',
    '',
  ].join('\n');
}

/**
 * Build the JSON success surface via the central deterministic emitter
 * (sorted keys, two-space indent, trailing newline).
 */
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

  // No-overwrite rule: refuse to clobber an existing file. Exit code is the
  // canonical "generic failure" so scripts can distinguish overwrite
  // refusal from validation failures.
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

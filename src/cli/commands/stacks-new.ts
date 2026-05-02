/**
 * R3 sprint 4 — `gan stacks new <name> [--tier=project|repo] [--project-root DIR]`.
 *
 * Scaffolds a DRAFT-bannered stack file at the chosen tier. Default tier is
 * `project` (writes to `<root>/.claude/gan/stacks/<name>.md`); `--tier=repo`
 * writes to `<root>/stacks/<name>.md`. The user tier is unsupported here —
 * `--tier=user` exits 64 with a structured error (per the scaffold-no-user
 * rule: user-tier scaffolding is not part of v1).
 *
 * Refuses to overwrite an existing file (the scaffold-no-overwrite rule):
 * exits 1 with a clear stderr message naming the absolute path. The CLI
 * never exposes a `--force` flag in v1.
 *
 * Persistence flows through R1's `atomicWriteFile` so the write is
 * atomic-by-rename. Bytes written equal `buildScaffold(name)`
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
import { buildScaffold } from '../lib/scaffold.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { EXIT_BAD_ARGS, EXIT_GENERIC, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

type ScaffoldTier = 'project' | 'repo';

const ALLOWED_TIERS: ReadonlySet<ScaffoldTier> = new Set<ScaffoldTier>(['project', 'repo']);

/**
 * Read and validate `--tier`. Returns the resolved tier (default `project`)
 * or a `ConfigServerError` describing the failure (rendered as exit 64).
 *
 * `--tier=user` is rejected explicitly: the user tier exists for cascade
 * mechanics (C3/C4) and shadow stacks (C5), but `gan stacks new` does not
 * scaffold there — it would invite committed copies of personal user-tier
 * forks. The error message names the supported values.
 */
function readTier(parsed: ParsedArgs): ScaffoldTier | ConfigServerError {
  const raw = parsed.flags['tier'];
  if (raw === undefined || raw === false) return 'project';
  if (raw === true) {
    return createError('MalformedInput', {
      field: '--tier',
      message: '--tier requires a value (`project` or `repo`).',
    });
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return createError('MalformedInput', {
      field: '--tier',
      message: '--tier requires a value (`project` or `repo`).',
    });
  }
  if (raw === 'user') {
    return createError('MalformedInput', {
      field: '--tier',
      message:
        'gan stacks new does not support --tier=user; the user tier is not a supported scaffold target. Use --tier=project (default) or --tier=repo.',
    });
  }
  if (!ALLOWED_TIERS.has(raw as ScaffoldTier)) {
    return createError('MalformedInput', {
      field: '--tier',
      message: `--tier must be 'project' or 'repo' (got '${raw}').`,
    });
  }
  return raw as ScaffoldTier;
}

/** Resolve the absolute target path for the named stack at the given tier. */
function targetPathFor(projectRoot: string, tier: ScaffoldTier, name: string): string {
  if (tier === 'repo') {
    return path.join(projectRoot, 'stacks', `${name}.md`);
  }
  return path.join(projectRoot, '.claude', 'gan', 'stacks', `${name}.md`);
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

  const body = buildScaffold(name);
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

/**
 * R-post sprint 6 — `gan stacks where [<name>]`.
 *
 * No name → prints the absolute path to the framework's built-in stacks
 * directory (`<packageRoot>/stacks/`). Useful for users who want to know
 * "where does the framework keep its stacks?".
 *
 * Named → calls R1's `getStackResolution({projectRoot, name})` and prints
 * the resolved path with its tier provenance. Resolution follows C5's
 * four-tier order; the highest-priority tier wins.
 *
 * JSON shapes:
 *   - no name: `{kind: "builtin-directory", path}`.
 *   - named:   `{name, path, tier}`.
 *
 * Exit codes:
 *   - 0 on success;
 *   - 2 (validation bucket) when the named stack is missing in every tier
 *     (R1's `getStackResolution` raises `MissingFile`).
 */

import path from 'node:path';

import { getStackResolution } from '../../index.js';
import { packageRoot as resolvePackageRoot } from '../../config-server/package-root.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { errorResult, readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import { EXIT_OK, exitCodeFor } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';
import type { StackTier } from '../../config-server/resolution/stack-resolution.js';

/**
 * @internal test-only env var: `GAN_PACKAGE_ROOT_OVERRIDE`. Mirrors the
 *   helper in `stacks-available.ts`.
 */
function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];

  // No name: print the built-in stacks directory and exit 0.
  if (name === undefined || name.length === 0) {
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
      if (wantJson) {
        return { stdout: renderErrorJson(err), stderr: '', code: exitCodeFor(err.code) };
      }
      return { stdout: '', stderr: renderError(err), code: exitCodeFor(err.code) };
    }
    if (wantJson) {
      return {
        stdout: emitJson({ kind: 'builtin-directory', path: stacksDir }),
        stderr: '',
        code: EXIT_OK,
      };
    }
    return { stdout: `${stacksDir}\n`, stderr: '', code: EXIT_OK };
  }

  // Named: resolve via R1's stack resolver.
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  let resolved: { path: string; tier: StackTier };
  try {
    const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    const ctx =
      typeof override === 'string' && override.length > 0 ? { packageRoot: override } : undefined;
    resolved = getStackResolution({ projectRoot, name }, ctx);
  } catch (e) {
    return errorResult(e, wantJson);
  }

  if (wantJson) {
    return {
      stdout: emitJson({ name, path: resolved.path, tier: resolved.tier }),
      stderr: '',
      code: EXIT_OK,
    };
  }
  return {
    stdout: `${resolved.path}  (tier: ${resolved.tier})\n`,
    stderr: '',
    code: EXIT_OK,
  };
}

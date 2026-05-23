

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

function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];

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

  let projectRoot: string;
  let projectRootDisplay: string;
  try {
    const resolvedRoot = resolveProjectRoot(rootFlag);
    projectRoot = resolvedRoot.path;
    projectRootDisplay = resolvedRoot.displayPath;
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

  const resolvedPathDisplay =
    projectRoot !== projectRootDisplay && resolved.path.startsWith(projectRoot)
      ? projectRootDisplay + resolved.path.slice(projectRoot.length)
      : resolved.path;

  if (wantJson) {
    return {
      stdout: emitJson({ name, path: resolvedPathDisplay, tier: resolved.tier }),
      stderr: '',
      code: EXIT_OK,
    };
  }
  return {
    stdout: `${resolvedPathDisplay}  (tier: ${resolved.tier})\n`,
    stderr: '',
    code: EXIT_OK,
  };
}

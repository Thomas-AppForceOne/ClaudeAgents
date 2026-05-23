/**
 * `gan stacks where [name]` — report *where* a stack would resolve from.
 *
 * Two modes, keyed on whether a name is given:
 * - no name → print the built-in stacks *directory* path (project-independent).
 * - a name → resolve that stack for the project and print its file path and
 *   tier.
 *
 * Read-only (no writes). When the project root is displayed in an
 * abbreviated/relative form, resolved paths under it are rewritten to match
 * that display form so output stays consistent with what the user typed.
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
 * Resolve the installed package's built-in `stacks/` directory.
 *
 * Honours `GAN_PACKAGE_ROOT_OVERRIDE` (test fixture seam) before the real
 * package-root resolver. May throw if the underlying resolver throws.
 */
function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

/**
 * CLI entrypoint for `gan stacks where`.
 *
 * @param parsed parsed argv; the optional first positional is the stack name,
 *   and `--json` / `--project-root` are honoured.
 * @returns a {@link CommandResult}. Failure modes are returned as data:
 *   - no name + a package-root failure → a `MissingFile`-class error with its
 *     mapped exit code;
 *   - with a name, project-root resolution or stack resolution throwing →
 *     mapped via {@link errorResult}.
 *   On success, exit {@link EXIT_OK} with the directory path (no name) or the
 *   resolved file path and tier (with a name) on `stdout`.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  const name = parsed._[0];

  // No name → report the built-in stacks directory itself, independent of any
  // project.
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
    // Forward the package-root override into resolution so the test seam
    // governs both the directory listing and per-stack resolution identically.
    const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    const ctx =
      typeof override === 'string' && override.length > 0 ? { packageRoot: override } : undefined;
    resolved = getStackResolution({ projectRoot, name }, ctx);
  } catch (e) {
    return errorResult(e, wantJson);
  }

  // Rewrite a resolved path that lives under the project root to use the
  // root's display form, so the output matches how the user referred to the
  // project rather than leaking the canonical absolute path.
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

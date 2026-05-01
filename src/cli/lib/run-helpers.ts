/**
 * R3 sprint 2 — shared helpers for read-subcommand entrypoints.
 *
 * Every read subcommand (`config print|get`, `stacks list`, `stack show`,
 * `modules list`) follows the same shape:
 *
 *   1. Read `--json` and `--project-root` from `parsed.flags`.
 *   2. Resolve project root via the F3-canonicalised helper.
 *   3. Call an R1 library function with the resolved root.
 *   4. Render success (human or JSON) / errors (human or JSON) per the
 *      `--json` round-trip rule (PROJECT_CONTEXT.md).
 *   5. Map every error to an exit code via `exitCodeFor`.
 *
 * `runRead` factors steps (2)+(4)+(5) so each command only owns its
 * library call and its human renderer.
 */

import { ConfigServerError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from './errors.js';
import { emitJson } from './json-output.js';
import { EXIT_API_UNREACHABLE, EXIT_OK, exitCodeFor } from './exit-codes.js';
import { resolveProjectRoot } from './project-root.js';
import type { ParsedArgs } from './args.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Read `--json` and `--project-root` from the parsed args. Centralised so
 * each command can keep its body focused on the library call.
 */
export function readSharedFlags(parsed: ParsedArgs): {
  wantJson: boolean;
  rootFlag: string | undefined;
} {
  const wantJson = parsed.flags['json'] === true;
  const rootFlag =
    typeof parsed.flags['project-root'] === 'string'
      ? (parsed.flags['project-root'] as string)
      : undefined;
  return { wantJson, rootFlag };
}

/**
 * Build the "library unreachable" CommandResult per the F-AC6 contract.
 * Stderr surface (no `--json`) carries the human remediation; stdout under
 * `--json` carries an F2-shaped error object (`code: ApiUnreachable`) so
 * `gan ... --json | jq` parses cleanly even on the unreachable path.
 */
export function unreachableResult(wantJson: boolean): CommandResult {
  if (wantJson) {
    return {
      stdout: renderErrorJson({
        code: 'ApiUnreachable',
        message:
          "cannot reach the framework's library. Run `install.sh` from the framework's repo root.",
      }),
      stderr: '',
      code: EXIT_API_UNREACHABLE,
    };
  }
  return {
    stdout: '',
    stderr:
      "Error: cannot reach the framework's library. " +
      "Run `install.sh` from the framework's repo root.\n",
    code: EXIT_API_UNREACHABLE,
  };
}

/**
 * Map a thrown value to a CommandResult under the R3 error-output rules.
 *
 *   - `ConfigServerError` → use `exitCodeFor(err.code)`.
 *   - anything else → treat as "library unreachable" (exit 5).
 *
 * `--json` puts the structured error on stdout; without `--json` we render
 * human text on stderr.
 */
export function errorResult(err: unknown, wantJson: boolean): CommandResult {
  if (!(err instanceof ConfigServerError)) {
    return unreachableResult(wantJson);
  }
  const code = exitCodeFor(err.code);
  if (wantJson) {
    return { stdout: renderErrorJson(err), stderr: '', code };
  }
  return { stdout: '', stderr: renderError(err), code };
}

/**
 * Drive a read subcommand: resolve the project root, then call `body` with
 * the resolved canonical path. The body returns the success payload (any
 * value); `humanRenderer` formats it for stdout when `--json` is unset.
 *
 * The `wantJson` branch always emits via `emitJson` so every JSON output
 * goes through one call site (the single-implementation rule).
 */
export async function runRead<T>(
  parsed: ParsedArgs,
  body: (projectRoot: string) => Promise<T>,
  humanRenderer: (value: T) => string,
): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  try {
    const value = await body(projectRoot);
    const stdout = wantJson ? emitJson(value) : humanRenderer(value);
    return { stdout, stderr: '', code: EXIT_OK };
  } catch (e) {
    return errorResult(e, wantJson);
  }
}



/**
 * Shared scaffolding for command implementations.
 *
 * Read-style commands (`config print`, `stack show`, `modules list`, …) all
 * share the same envelope: read the common flags, resolve the project root,
 * run the command body, then render the result as either human text or JSON
 * and turn any thrown error into a {@link CommandResult} with the right exit
 * code. That envelope lives here once, in {@link runRead}, plus the error
 * helpers it relies on, so individual commands carry only their own logic.
 *
 * Shared guarantee: every function here returns failures as a
 * {@link CommandResult} (a value with stdout/stderr/code) — they never throw
 * to the caller. The `--json` vs. human choice is honoured uniformly on both
 * the success and failure paths.
 */

import { ConfigServerError } from '../../config-server/errors.js';
import { renderError, renderErrorJson } from './errors.js';
import { emitJson } from './json-output.js';
import { EXIT_API_UNREACHABLE, EXIT_OK, exitCodeFor } from './exit-codes.js';
import { resolveProjectRoot } from './project-root.js';
import type { ParsedArgs } from './args.js';

/**
 * The uniform return shape of every command: text destined for stdout, text
 * destined for stderr, and the process exit code. The dispatcher writes the
 * streams and exits with `code`.
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Extract the two flags every command shares from already-parsed args.
 *
 * @param parsed the parsed CLI args.
 * @returns `wantJson` — `true` only when `--json` was set to the boolean
 *   `true`; and `rootFlag` — the `--project-root` value when it is a string,
 *   else `undefined` (so a missing or non-string flag uniformly means "use the
 *   cwd" downstream).
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
 * Build the canonical "framework library unreachable" result.
 *
 * This is the outcome when the bundled config-server library cannot be loaded
 * at all — i.e. a non-`ConfigServerError` escaped the command body, which is
 * treated as the install being broken rather than a per-command failure. The
 * remediation (run `install.sh`) is baked into both the JSON and human forms.
 *
 * @param wantJson render the error as JSON (stdout) when `true`, else as human
 *   text (stderr).
 * @returns a {@link CommandResult} with code `EXIT_API_UNREACHABLE`.
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
 * Convert a caught error into a rendered {@link CommandResult}.
 *
 * Only a {@link ConfigServerError} is treated as a structured, expected
 * failure: its `code` is mapped to an exit code via {@link exitCodeFor} and it
 * is rendered (JSON or human) accordingly. Anything else is taken to mean the
 * framework library could not be reached and is funnelled to
 * {@link unreachableResult} — the assumption being that a non-`ConfigServerError`
 * escaping a command body indicates a broken install, not a normal failure.
 *
 * @param err the caught value (any type).
 * @param wantJson choose JSON vs. human rendering.
 * @returns the rendered failure result; never throws.
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
 * Run a read-only command end to end with the shared envelope.
 *
 * Steps, in order: read the shared flags, resolve the project root (a failure
 * here short-circuits to an error result), invoke `body` with the canonical
 * root, then render its return value as JSON or via `humanRenderer`. Any error
 * thrown either by root resolution or by `body` is funnelled through
 * {@link errorResult}, so the function itself never throws.
 *
 * @param parsed the parsed CLI args for this command.
 * @param body the command's work; receives the canonical project-root path and
 *   resolves to the value to render. May throw — a thrown `ConfigServerError`
 *   becomes a structured failure, any other throw becomes "unreachable".
 * @param humanRenderer renders `body`'s value to human-readable text; used only
 *   when `--json` was not requested.
 * @returns the {@link CommandResult}: success carries the rendered value on
 *   stdout with `EXIT_OK`; failure carries the rendered error and its mapped
 *   exit code.
 */
export async function runRead<T>(
  parsed: ParsedArgs,
  body: (projectRoot: string) => Promise<T>,
  humanRenderer: (value: T) => string,
): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  // Resolve (and validate) the root before running the body so an invalid
  // --project-root fails fast with its own structured error, before any work.
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



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

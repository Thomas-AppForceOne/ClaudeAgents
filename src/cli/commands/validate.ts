/**
 * `gan validate` — run every configuration validator for a project and report
 * the collected issues.
 *
 * Validation issues are *data*, not errors: a project with problems still
 * exits cleanly through the normal output path, and the issue severities (not
 * the presence of a thrown exception) drive the exit code. A genuine fault
 * while validating (a thrown {@link ConfigServerError}) is the only thing that
 * routes through the error path.
 */

import { validateAll, type Issue } from '../../index.js';
import { ConfigServerError } from '../../config-server/errors.js';
import { emitJson } from '../lib/json-output.js';
import {
  errorResult,
  readSharedFlags,
  unreachableResult,
  type CommandResult,
} from '../lib/run-helpers.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { EXIT_OK, exitCodeForIssues } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Shape returned by `validateAll`.
 *
 * @property issues every validation issue found; an empty array means the
 *   project validated clean.
 */
interface ValidateAllResult {
  issues: Issue[];
}

/**
 * Format one issue as a single human-readable line.
 *
 * @param issue the issue to format.
 * @returns `"<severity> <code> <path>[:<field>]: <message>"`. Severity
 *   defaults to `error` when unset; an absent/empty path renders as
 *   `<no-path>`; the `:field` suffix is omitted when there is no field.
 */
function formatIssueLine(issue: Issue): string {
  const sev = issue.severity ?? 'error';
  const subject = issue.path && issue.path.length > 0 ? issue.path : '<no-path>';
  const field = issue.field && issue.field.length > 0 ? `:${issue.field}` : '';
  return `${sev} ${issue.code} ${subject}${field}: ${issue.message}`;
}

/**
 * Render the validation result for human (non-JSON) output: one line per
 * issue followed by a count summary (with correct singular/plural).
 *
 * @param result the collected issues.
 * @returns the formatted report with a trailing newline; for a clean project
 *   it is just the `0 issues found.` summary line.
 */
function renderHuman(result: ValidateAllResult): string {
  const lines: string[] = [];
  for (const issue of result.issues) {
    lines.push(formatIssueLine(issue));
  }
  const n = result.issues.length;
  const summary = n === 1 ? '1 issue found.' : `${n} issues found.`;
  lines.push(summary);
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan validate`.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root`.
 * @returns a {@link CommandResult}. Failure modes are returned as data:
 *   project-root resolution or a thrown {@link ConfigServerError} maps via
 *   {@link errorResult}; any other thrown value becomes
 *   {@link unreachableResult}. On a completed validation the report is on
 *   `stdout` and the exit code is {@link EXIT_OK} when clean, otherwise the
 *   severity-derived code from {@link exitCodeForIssues}.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  let result: ValidateAllResult;
  try {
    result = validateAll({ projectRoot });
  } catch (e) {
    // A ConfigServerError is an expected, mapped fault; anything else is
    // unexpected and is reported as the library being unreachable.
    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  // Exit code is driven by issue severity, not by the count: a clean run is OK,
  // otherwise the strictest issue decides the code.
  const code = result.issues.length === 0 ? EXIT_OK : exitCodeForIssues(result.issues);
  const stdout = wantJson ? emitJson(result) : renderHuman(result);
  return { stdout, stderr: '', code };
}

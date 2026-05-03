/**
 * R3 sprint 4 — `gan validate [--json] [--project-root DIR]`.
 *
 * Calls R1's `validateAll({ projectRoot })` in-process (per the
 * CLI-imports-library rule). Renders a human-readable report on stdout
 * and maps the issue list to an exit code via the centralized
 * `exitCodeForIssues` helper.
 *
 * Output:
 *   - human (default): one line per issue followed by a summary count.
 *     Issue line format:
 *
 *       <severity> <code> <path>[<:field>]: <message>
 *
 *     The last non-empty line is `<N> issue(s) found.` (singular form
 *     when N == 1; the success path emits `0 issues found.`).
 *
 *   - `--json`: emits the full `validateAll` return value via the central
 *     `emitJson` helper (sorted keys, two-space indent, trailing newline).
 *
 * Exit codes (via `lib/exit-codes.ts`):
 *   - 0 if no error-severity issues
 *   - 4 if any `InvariantViolation`
 *   - 3 if any `SchemaMismatch` (and no invariant violations)
 *   - 2 otherwise
 *   - 5 if R1's library is unreachable (rare; usually a build problem)
 *
 * No literal numeric exit codes appear in this file (per AN20).
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

interface ValidateAllResult {
  issues: Issue[];
}

/**
 * Format one issue as a single line. The format string is locked by the
 * sprint contract (AC18): `<severity> <code> <path>[<:field>]: <message>`.
 *
 * Issues without a `path` (rare; only some pipeline-level errors lack one)
 * render with `<no-path>` so the format never collapses into ambiguity.
 */
function formatIssueLine(issue: Issue): string {
  const sev = issue.severity ?? 'error';
  const subject = issue.path && issue.path.length > 0 ? issue.path : '<no-path>';
  const field = issue.field && issue.field.length > 0 ? `:${issue.field}` : '';
  return `${sev} ${issue.code} ${subject}${field}: ${issue.message}`;
}

/**
 * Render the human report. The summary line is always last and obeys
 * pluralisation: `0 issues found.`, `1 issue found.`, `N issues found.`.
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
    if (e instanceof ConfigServerError) {
      return errorResult(e, wantJson);
    }
    return unreachableResult(wantJson);
  }

  const code = result.issues.length === 0 ? EXIT_OK : exitCodeForIssues(result.issues);
  const stdout = wantJson ? emitJson(result) : renderHuman(result);
  return { stdout, stderr: '', code };
}

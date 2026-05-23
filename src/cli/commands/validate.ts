

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

function formatIssueLine(issue: Issue): string {
  const sev = issue.severity ?? 'error';
  const subject = issue.path && issue.path.length > 0 ? issue.path : '<no-path>';
  const field = issue.field && issue.field.length > 0 ? `:${issue.field}` : '';
  return `${sev} ${issue.code} ${subject}${field}: ${issue.message}`;
}

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



import { stableStringify } from './json.js';

export interface ReportFailure {

  path: string;

  code: string;

  message: string;

  field?: string;
}

export interface LintStacksReport {
  kind: 'lint-stacks';

  checked: number;

  failures: ReportFailure[];
}

export interface PairNamesReport {
  kind: 'pair-names';

  checked: number;

  failures: ReportFailure[];
}

export interface EvaluatorPipelineCheckReport {
  kind: 'evaluator-pipeline-check';

  checked: number;

  failures: ReportFailure[];
}

export interface PublishSchemasReport {
  kind: 'publish-schemas';

  checked: number;

  failures: ReportFailure[];

  rewritten?: number;
}

export interface LintNoStackLeakReport {
  kind: 'lint-no-stack-leak';

  checked: number;

  failures: ReportFailure[];
}

export interface LintErrorTextReport {
  kind: 'lint-error-text';

  checked: number;

  failures: ReportFailure[];
}

export type ScriptReport =
  | LintStacksReport
  | PairNamesReport
  | EvaluatorPipelineCheckReport
  | PublishSchemasReport
  | LintNoStackLeakReport
  | LintErrorTextReport;

export interface FormattedReport {
  stdout: string;
  stderr: string;
}

export function formatReport(input: ScriptReport): FormattedReport {
  if (input.kind === 'lint-stacks') {
    return formatLintStacks(input);
  }
  if (input.kind === 'pair-names') {
    return formatPairNames(input);
  }
  if (input.kind === 'evaluator-pipeline-check') {
    return formatEvaluatorPipelineCheck(input);
  }
  if (input.kind === 'publish-schemas') {
    return formatPublishSchemas(input);
  }
  if (input.kind === 'lint-no-stack-leak') {
    return formatLintNoStackLeak(input);
  }
  if (input.kind === 'lint-error-text') {
    return formatLintErrorText(input);
  }

  const _exhaustive: never = input;
  return _exhaustive;
}

function formatLintStacks(input: LintStacksReport): FormattedReport {
  const failedCount = countFailedFiles(input.failures);
  const stdout = `${input.checked} stacks checked, ${failedCount} failed\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function formatPairNames(input: PairNamesReport): FormattedReport {
  const failedCount = countFailedFiles(input.failures);
  const stdout = `${input.checked} stacks checked, ${failedCount} failed\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function formatEvaluatorPipelineCheck(input: EvaluatorPipelineCheckReport): FormattedReport {
  const failedCount = countFailedFiles(input.failures);
  const stdout = `${input.checked} fixtures checked, ${failedCount} failed\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function formatPublishSchemas(input: PublishSchemasReport): FormattedReport {
  const failedCount = countFailedFiles(input.failures);

  const stdout = `${input.checked} schemas checked, ${failedCount} failed\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function formatLintNoStackLeak(input: LintNoStackLeakReport): FormattedReport {
  const stdout = `${input.checked} files scanned, ${input.failures.length} hits\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function formatLintErrorText(input: LintErrorTextReport): FormattedReport {
  const stdout = `${input.checked} files scanned, ${input.failures.length} hits\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

function countFailedFiles(failures: readonly ReportFailure[]): number {
  const seen = new Set<string>();
  for (const f of failures) {
    seen.add(f.path);
  }
  return seen.size;
}

export function formatReportJson(input: ScriptReport): string {
  if (input.kind === 'lint-stacks') {
    return renderJson(input);
  }
  if (input.kind === 'pair-names') {
    return renderJson(input);
  }
  if (input.kind === 'evaluator-pipeline-check') {
    return renderJson(input);
  }
  if (input.kind === 'publish-schemas') {
    return renderJson(input);
  }
  if (input.kind === 'lint-no-stack-leak') {
    return renderJson(input);
  }
  if (input.kind === 'lint-error-text') {
    return renderJson(input);
  }

  const _exhaustive: never = input;
  return _exhaustive;
}

function renderJson(input: ScriptReport): string {
  const failedCount = countFailedFiles(input.failures);
  const payload = {
    checked: input.checked,
    failed: failedCount,
    failures: input.failures.map((f) => {
      const entry: Record<string, string> = {
        code: f.code,
        message: f.message,
        path: f.path,
      };
      if (typeof f.field === 'string') {
        entry['field'] = f.field;
      }
      return entry;
    }),
  };
  return stableStringify(payload);
}

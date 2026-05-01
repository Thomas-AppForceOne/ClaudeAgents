/**
 * Shared output formatter for R4 maintainer scripts.
 *
 * Every R4 script reports the same shape:
 *   - a one-line summary on stdout (e.g. `3 stacks checked, 1 failed`);
 *   - one line per failure on stderr, naming the absolute path, the
 *     issue code, and a human-readable message.
 *
 * `formatReport` is the single point of implementation; future scripts
 * (`publish-schemas`, `pair-names`, `lint-no-stack-leak`, …) re-use it
 * by extending the discriminated `kind` union.
 *
 * `formatReportJson` returns the same data as a sorted-key,
 * two-space-indent JSON document with a trailing newline (per F3
 * determinism). The JSON shape is `{checked, failed, failures: [...]}`.
 *
 * Per anti-criterion AN5, `JSON.stringify` is forbidden inside
 * `scripts/`; this module relies on `stableStringify` from the
 * determinism module via `./json.js`.
 */

import { stableStringify } from './json.js';

export interface ReportFailure {
  /** Absolute filesystem path of the offending file. */
  path: string;
  /** F2-shaped issue code (e.g. `ScaffoldBannerPresent`, `SchemaMismatch`). */
  code: string;
  /** Human-readable description; F4 prose discipline applies. */
  message: string;
}

export interface LintStacksReport {
  kind: 'lint-stacks';
  /** Number of stack files inspected. */
  checked: number;
  /** Subset of inspected files that produced at least one failure. */
  failures: ReportFailure[];
}

/**
 * Discriminated union of every per-script report shape. New scripts add
 * their own `kind` arm and `formatReport` grows a new branch.
 */
export type ScriptReport = LintStacksReport;

export interface FormattedReport {
  stdout: string;
  stderr: string;
}

/**
 * Render a report as `{stdout, stderr}`. Stdout always ends with a
 * single trailing newline. Stderr is empty on success and contains one
 * line per failure (each terminated by `\n`) on failure.
 */
export function formatReport(input: ScriptReport): FormattedReport {
  if (input.kind === 'lint-stacks') {
    return formatLintStacks(input);
  }
  // Exhaustiveness guard. The `never` assignment forces a compile error
  // if a new `kind` is added without a matching branch above.
  const _exhaustive: never = input.kind;
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

function countFailedFiles(failures: readonly ReportFailure[]): number {
  const seen = new Set<string>();
  for (const f of failures) {
    seen.add(f.path);
  }
  return seen.size;
}

/**
 * Render the same report as a sorted-key JSON document with a trailing
 * newline. Used by `--json` paths in maintainer scripts.
 */
export function formatReportJson(input: ScriptReport): string {
  const failedCount = countFailedFiles(input.failures);
  const payload = {
    checked: input.checked,
    failed: failedCount,
    failures: input.failures.map((f) => ({
      code: f.code,
      message: f.message,
      path: f.path,
    })),
  };
  return stableStringify(payload);
}

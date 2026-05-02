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
  /**
   * Optional structured field path (e.g. `/pairsWith`). Surfaced by
   * invariant-driven scripts whose underlying `Issue` carries a `field`;
   * omitted by checks that only have a file-level scope.
   */
  field?: string;
}

export interface LintStacksReport {
  kind: 'lint-stacks';
  /** Number of stack files inspected. */
  checked: number;
  /** Subset of inspected files that produced at least one failure. */
  failures: ReportFailure[];
}

/**
 * Report shape for `scripts/pair-names/`. Mirrors `LintStacksReport` —
 * the failure-counting rule (`failed` = unique-file count among
 * `failures`) is shared so the summary line stays consistent across
 * maintainer scripts.
 */
export interface PairNamesReport {
  kind: 'pair-names';
  /** Number of stack files inspected (every row in the snapshot). */
  checked: number;
  /** Subset of inspected files that produced at least one invariant failure. */
  failures: ReportFailure[];
}

/**
 * Report shape for `scripts/evaluator-pipeline-check/`. The script seeds
 * a deterministic-core golden per fixture and diffs the live
 * `validateAll` output against it; `checked` is the fixture count and
 * `failures` carries `GoldenMissing` / `GoldenDriftDetected` entries.
 */
export interface EvaluatorPipelineCheckReport {
  kind: 'evaluator-pipeline-check';
  /** Number of bootstrap fixtures inspected. */
  checked: number;
  /** Subset of fixtures whose golden was missing or drifted. */
  failures: ReportFailure[];
}

/**
 * Report shape for `scripts/publish-schemas/`. The script reads each
 * published schema, parses it, re-emits it via `stableStringify`, and
 * compares the on-disk bytes to the canonical form. `checked` is the
 * total schema count; `failures` carries `SchemaMissing`,
 * `SchemaParseError`, and `SchemaDrift` entries; `rewritten` (write
 * mode only) reports how many on-disk schemas the script repaired in
 * place via `atomicWriteFile`.
 */
export interface PublishSchemasReport {
  kind: 'publish-schemas';
  /** Number of schema files inspected. */
  checked: number;
  /** Subset of schemas that were missing, unparseable, or drifted. */
  failures: ReportFailure[];
  /**
   * Optional: number of schemas re-written in canonical form. Populated
   * in write mode (default); omitted in `--dry-run` mode.
   */
  rewritten?: number;
}

/**
 * Report shape for `scripts/lint-no-stack-leak/`. The script walks a
 * fixed scan scope (`agents/*.md`, `skills/gan/SKILL.md`, recursive
 * `src/config-server/**\/*.ts`) looking for ecosystem-specific tokens
 * that would leak Node/npm-shaped vocabulary outside their owning stack
 * file. `checked` is the count of files inspected; `failures` carries
 * `LeakDetected` and `EmptyTransitionalEntry` entries.
 */
export interface LintNoStackLeakReport {
  kind: 'lint-no-stack-leak';
  /** Number of files inspected. */
  checked: number;
  /** Subset of inspected files (and allowlist entries) that produced a hit. */
  failures: ReportFailure[];
}

/**
 * Report shape for `scripts/lint-error-text/`. The script walks
 * `src/config-server/**\/*.ts` and `src/cli/**\/*.ts` looking for lines
 * that emit a user-facing message (matching one of the known emit-site
 * patterns) AND contain a forbidden ecosystem token. `checked` is the
 * count of files inspected; `failures` carries `ErrorTextLeakDetected`
 * entries.
 */
export interface LintErrorTextReport {
  kind: 'lint-error-text';
  /** Number of files inspected. */
  checked: number;
  /** Subset of inspected files that produced at least one emit-site hit. */
  failures: ReportFailure[];
}

/**
 * Discriminated union of every per-script report shape. New scripts add
 * their own `kind` arm and `formatReport` grows a new branch.
 */
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

/**
 * Render a report as `{stdout, stderr}`. Stdout always ends with a
 * single trailing newline. Stderr is empty on success and contains one
 * line per failure (each terminated by `\n`) on failure.
 */
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
  // Exhaustiveness guard. The `never` assignment forces a compile error
  // if a new `kind` is added without a matching branch above.
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
  // The `rewritten` count is intentionally omitted from the stdout
  // summary line — it is surfaced only via the JSON form for now. This
  // keeps the one-liner consistent with the other R4 scripts; a
  // human-readable `(N rewritten)` suffix can be added later without
  // breaking the JSON shape.
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

/**
 * Render the same report as a sorted-key JSON document with a trailing
 * newline. Used by `--json` paths in maintainer scripts.
 */
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
  // Exhaustiveness guard for the JSON path. Mirrors `formatReport` so
  // adding a new `kind` flags both functions at once.
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

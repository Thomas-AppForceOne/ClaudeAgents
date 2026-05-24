/**
 * Report model and rendering for the `scripts/` CLIs.
 *
 * Every script produces one {@link ScriptReport} — a discriminated union keyed
 * on `kind` — and then renders it for one of two audiences: a human (via
 * {@link formatReport}, which splits a one-line summary onto stdout and the
 * per-failure detail onto stderr) or a machine (via {@link formatReportJson},
 * a single canonical JSON document on stdout). Centralising the model here is
 * what lets a CI gate consume any script's `--json` output with one shape.
 *
 * Two conventions hold across every renderer here:
 * - The stdout summary counts *distinct files* that failed, not raw failure
 *   rows, so multiple violations in one file read as one failed file. (The
 *   leak/error-text variants instead report total hits — see those formatters.)
 * - Both `formatReport` and `formatReportJson` end with a `never`-typed
 *   exhaustiveness check, so adding a report `kind` without handling it is a
 *   compile error rather than a silent passthrough.
 */
import { stableStringify } from './json.js';

/**
 * One reported problem. Shared by every report variant so the renderers can
 * format any failure uniformly.
 *
 * @property path the file (or pseudo-path like `<harness>`) the failure is
 *   about; also the key used to count distinct failed files.
 * @property code a stable, machine-readable identifier (e.g. `SchemaDrift`)
 *   that tests and CI can match on without parsing the message.
 * @property message human-readable detail, typically including remediation.
 * @property field optional dotted/pointer location within the file; emitted to
 *   JSON only when present (an absent field is omitted, not set to null).
 * @property severity optional classification distinguishing a finding that must
 *   gate (`'blocker'`) from one reported for human attention only
 *   (`'advisory'`). Absent means the report variant does not grade by severity
 *   and the finding is treated as gating — so existing single-severity reports
 *   keep their meaning without setting the field. Emitted to JSON only when
 *   present, matching the `field` convention.
 */
export interface ReportFailure {
  path: string;

  code: string;

  message: string;

  field?: string;

  severity?: 'blocker' | 'advisory';
}

/**
 * Result of `lint-stacks`: stack `.md` files checked for the scaffold banner
 * and schema conformance. `checked` is the number of files scanned.
 */
export interface LintStacksReport {
  kind: 'lint-stacks';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Result of `pair-names`: stack files checked against the `pairsWith`
 * consistency invariant. `checked` is the number of stack files enumerated.
 */
export interface PairNamesReport {
  kind: 'pair-names';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Result of `evaluator-pipeline-check`: bootstrap fixtures whose evaluator
 * plan was diffed against a committed golden. `checked` is the number of
 * present fixtures actually run (missing fixtures surface as failures).
 */
export interface EvaluatorPipelineCheckReport {
  kind: 'evaluator-pipeline-check';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Result of `publish-schemas`: published JSON Schemas compared to their
 * canonical serialisation. `checked` is the fixed schema count.
 *
 * @property rewritten how many schemas were repaired in place (write mode);
 *   `0` or absent in `--dry-run`, where drift is reported as failures instead.
 */
export interface PublishSchemasReport {
  kind: 'publish-schemas';

  checked: number;

  failures: ReportFailure[];

  rewritten?: number;
}

/**
 * Result of `lint-no-stack-leak`: files scanned for forbidden ecosystem
 * tokens leaking outside their owning stack. Here a failure is a single token
 * *hit*, so the summary reports total hits rather than distinct files.
 */
export interface LintNoStackLeakReport {
  kind: 'lint-no-stack-leak';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Result of `lint-error-text`: emit-site lines scanned for forbidden tokens in
 * user-facing strings. Like the leak report, the summary counts total hits.
 */
export interface LintErrorTextReport {
  kind: 'lint-error-text';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Result of `doc-lint`: exported symbols and comments introduced or changed in
 * the merge-base delta, checked against the documentation rules. `checked` is
 * the number of delta `.ts`/`.tsx` files inspected (not symbols), so a clean
 * delta of N files reads as "N files checked, 0 failed". Like the schema/stack
 * reports, the summary counts distinct failed files rather than raw hits,
 * because several findings in one file are one file the author must revisit.
 *
 * Findings carry a {@link ReportFailure.severity}: the export-doc-presence rule
 * is a `'blocker'` (it gates), while the required-sections and
 * commented-out-code heuristics are `'advisory'` (reported, never gating on
 * their own). The exit-code routing — advisory-only is clean, any blocker
 * fails — lives in the tool, not the report shape; the report only records the
 * classification so a caller can tell the two apart.
 */
export interface DocLintReport {
  kind: 'doc-lint';

  checked: number;

  failures: ReportFailure[];
}

/**
 * Discriminated union of every script's report, keyed on `kind`. This is the
 * single type the renderers accept; the `kind` tag both selects the formatter
 * and drives the exhaustiveness checks that guard against an unhandled variant.
 */
export type ScriptReport =
  | LintStacksReport
  | PairNamesReport
  | EvaluatorPipelineCheckReport
  | PublishSchemasReport
  | LintNoStackLeakReport
  | LintErrorTextReport
  | DocLintReport;

/**
 * The two output streams a human-readable render produces. Kept separate so a
 * script can route the summary to stdout and the failure detail to stderr,
 * letting a clean run's stdout be machine-consumed or suppressed with
 * `--quiet` while errors still reach the terminal.
 */
export interface FormattedReport {
  stdout: string;
  stderr: string;
}

/**
 * Render a report for a human reader, splitting a one-line summary (stdout)
 * from the per-failure detail lines (stderr). On a clean run `stderr` is the
 * empty string. Pure: builds and returns strings with no I/O or mutation.
 *
 * @param input any {@link ScriptReport}; the `kind` tag selects the formatter.
 * @returns the {@link FormattedReport} stdout/stderr pair.
 * @remarks The trailing `never` assignment is an exhaustiveness guard — a new
 *   report `kind` that is not handled above fails type-checking here.
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
  if (input.kind === 'doc-lint') {
    return formatDocLint(input);
  }

  // Unreachable at runtime; exists so the compiler proves every `kind` above
  // is handled. Returning it keeps the function total without a real value.
  const _exhaustive: never = input;
  return _exhaustive;
}

// The per-kind formatters below share a template: a `"<n> <noun> checked,
// <m> failed"` (or `"... hits"`) stdout line, and one `path: code: message`
// line per failure on stderr. They differ only in the summary noun and in
// whether they count distinct failed files or raw hits, so they are kept
// separate (rather than parameterised) to keep each summary string literal.
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

// The two leak scanners report `failures.length` (total hits) rather than a
// distinct-file count, because one file can legitimately leak several tokens
// and each hit is independently actionable.
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

// doc-lint reports distinct failed files (not raw hits) like the stack/schema
// formatters: a finding is "this file introduced an undocumented export", and
// one summary line per file is what the author acts on. The detail line per
// failure carries the symbol via `field`, so several findings in one file are
// each visible on stderr while the summary stays one-file-one-count.
function formatDocLint(input: DocLintReport): FormattedReport {
  const failedCount = countFailedFiles(input.failures);
  const stdout = `${input.checked} files checked, ${failedCount} failed\n`;
  if (input.failures.length === 0) {
    return { stdout, stderr: '' };
  }
  const lines = input.failures.map((f) => `${f.path}: ${f.code}: ${f.message}`);
  const stderr = `${lines.join('\n')}\n`;
  return { stdout, stderr };
}

/**
 * Count how many *distinct* files appear across `failures`, deduplicating on
 * `path`. This is what the human summaries report as "failed", so several
 * violations in one file count once. Pure; does not mutate the input.
 */
function countFailedFiles(failures: readonly ReportFailure[]): number {
  const seen = new Set<string>();
  for (const f of failures) {
    seen.add(f.path);
  }
  return seen.size;
}

/**
 * Render a report as a single canonical JSON document for machine consumers
 * (the `--json` mode). Pure; returns a string and performs no I/O.
 *
 * @param input any {@link ScriptReport}.
 * @returns the deterministic JSON string (see {@link renderJson} for shape).
 * @remarks Like {@link formatReport}, ends in a `never` exhaustiveness guard.
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
  if (input.kind === 'doc-lint') {
    return renderJson(input);
  }

  // Same exhaustiveness guard as formatReport: a new unhandled `kind` is a
  // compile error here rather than silently producing no JSON.
  const _exhaustive: never = input;
  return _exhaustive;
}

/**
 * Serialise a report to the canonical JSON shape `{ checked, failed,
 * failures[] }`. Every variant funnels through this single shape so consumers
 * can parse any script's output identically.
 *
 * `failed` is the distinct-file count from {@link countFailedFiles}, not the
 * raw failure-array length, matching the human summary. Each failure entry
 * carries `code`/`message`/`path`, and `field` only when present — an absent
 * field is omitted entirely rather than emitted as `null`/`undefined`, keeping
 * the JSON minimal and stable. {@link stableStringify} fixes key order so the
 * bytes are reproducible across runs.
 */
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
      // Only attach `field` when it is actually a string, so the output omits
      // the key rather than serialising a missing optional.
      if (typeof f.field === 'string') {
        entry['field'] = f.field;
      }
      // Same omit-when-absent rule for `severity`: a report variant that does
      // not grade by severity emits no `severity` key at all, so its JSON shape
      // is unchanged by this field's existence — only graded variants (doc-lint)
      // carry it, letting a machine consumer route blocker vs. advisory.
      if (typeof f.severity === 'string') {
        entry['severity'] = f.severity;
      }
      return entry;
    }),
  };
  return stableStringify(payload);
}

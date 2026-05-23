/**
 * Public barrel for the shared `scripts/lib` helpers.
 *
 * Every CLI entrypoint under `scripts/` imports from here rather than reaching
 * into the individual modules, so this file is the single import surface the
 * scripts depend on. It re-exports the report formatters, the argument parser,
 * the exit-code contract, and deterministic JSON — bundling the four concerns
 * a script needs to parse its argv, do its work, and emit a report. Re-exports
 * only; no logic lives here.
 */
export { formatReport, formatReportJson } from './report.js';
export type {
  EvaluatorPipelineCheckReport,
  FormattedReport,
  LintErrorTextReport,
  LintNoStackLeakReport,
  LintStacksReport,
  PairNamesReport,
  PublishSchemasReport,
  ReportFailure,
  ScriptReport,
} from './report.js';
export { parseArgs } from './args.js';
export type { ArgsSpec, ParsedScriptArgs } from './args.js';
export { SCRIPT_EXIT } from './exit-codes.js';
export type { ScriptExit } from './exit-codes.js';
export { stableStringify } from './json.js';

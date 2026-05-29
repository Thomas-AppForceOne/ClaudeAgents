#!/usr/bin/env node
/**
 * `lint-no-spec-ref` CLI — keeps internal phase-code references out of the
 * shipped surface.
 *
 * The shipped prompts (every `agents/*.md` and every file under `skills/gan/`)
 * run against end-user repositories that have no `specifications/` directory.
 * Internal phase codes (`F4`, `C1`, `F2`, …) and `specifications/<CODE>` paths
 * are repo-development vocabulary; surfacing them in user-facing prompts leaks
 * framework-internal taxonomy into the user's working environment. This script
 * walks the shipped surface and reports any line that names a phase code (with
 * an optional possessive `'s`) or a `specifications/<CODE>` path.
 *
 * Two matchers run side by side and share allowlist treatment. Both halve the
 * search to load-bearing references: the floor regexes are stated below in the
 * code, and each is justified next to its definition.
 *
 * Allowlists are line/region-scoped rather than whole-file, because most of
 * `SKILL.md` MUST be policed even though one example block inside it is
 * intentionally exempt. The allowlist tiers are:
 *
 * 1. The `EXAMPLES` region inside `SKILL.md`'s help-text fenced code block —
 *    a literal user-facing example carries the `--spec specifications/...md`
 *    sample line, which is the one place a path reference is welcome.
 * 2. A status-marker token (`[shipped-in-v<release>]`, `[partial-v<release>]`,
 *    `[deferred-to-v<release>]`) anywhere on the line — the lowercase `v` in
 *    the release pattern already prevents a false positive against the floor
 *    regex (which only flags an uppercase phase letter), but the allowlist is
 *    defensive in case a future tightening capitalises that letter.
 *
 * Output/exit follow the shared `scripts/lib` contract (`0`/`1`/`64`); the
 * report counts total hits, matching the existing leak scanners. `run` is
 * exported and read-only; `main` owns argv and process I/O.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  type LintNoStackLeakReport,
  type ReportFailure,
} from '../lib/index.js';

/**
 * Stable issue code for a bare-or-possessive phase-code reference found in the
 * shipped surface (e.g. `F4`, `C1's`). Tests and CI match on this constant
 * rather than the literal string so a wording change does not break either.
 */
const PHASE_CODE_REFERENCE_CODE = 'PhaseCodeReferenceDetected';

/**
 * Stable issue code for a `specifications/<CODE>` path reference (e.g.
 * `specifications/F2-config-api.md`). Distinct from the phase-code finding so
 * a reviewer can tell prose-citation drift from path-citation drift.
 */
const SPEC_PATH_REFERENCE_CODE = 'SpecPathReferenceDetected';

// Repo root derived from this compiled module's location (dist/scripts/...),
// so the default scan root resolves regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Phase-code letter set. The enumeration matches the phase codes documented in
 * `specifications/roadmap.md` § "How to read the spec set"; widening it would
 * pick up unrelated single-uppercase initialisms (e.g. `JSON`, `URL`) and the
 * narrower form is what makes the lint safe to run on prose.
 */
const PHASE_LETTERS = 'ACDEFHIMOQRSTUVWB';

/**
 * Word-boundary matcher for a bare or possessive phase-code reference. The
 * mandatory `\d+` is load-bearing: without it, the matcher would flag the
 * standalone English words `A` and `I` that appear frequently in prose
 * (`A snapshot`, `I will`). Tightening to `\d+` collapses every false positive
 * those two letters would otherwise generate while still catching `F4`,
 * `C1`, `F2`, etc. The optional `'s` covers possessive forms (`C1's`).
 */
const PHASE_CODE_REGEX = new RegExp(`\\b([${PHASE_LETTERS}]\\d+)('s)?\\b`, 'g');

/**
 * Path matcher for `specifications/<CODE>...` references. The leading enumerated
 * letter set + mandatory `\d+` excludes paths the project keeps deliberately
 * available to shipped prose (`specifications/roadmap.md`,
 * `specifications/roadmap-vote.md`, `specifications/deferred/README.md`),
 * because none of those segments start with `[PHASE_LETTERS]\d+`.
 */
const SPEC_PATH_REGEX = new RegExp(`specifications\\/([${PHASE_LETTERS}]\\d+)`, 'g');

/**
 * Sentinel literals that mark the head and tail of the SKILL.md help-text
 * EXAMPLES block. The check is whole-line equality on the trimmed line so an
 * accidental trailing space cannot break detection, and so the same matcher
 * survives a future re-flow that re-indents the help text inside the fenced
 * code block.
 */
const SKILL_FILE_BASENAME = 'SKILL.md';
const EXAMPLES_HEAD_LINE = 'EXAMPLES';
const EXAMPLES_TAIL_LINES = new Set(['CONFIGURATION', 'OUTPUT', 'FLAGS', 'USAGE']);

/**
 * Status-marker literal prefixes. A line that contains any of these literally
 * is treated as carrying a marker token — the matcher skips the full `[...]`
 * span when scanning that line. The pattern is `[<prefix><release>]` where
 * `<release>` is e.g. `1.0`; the lowercase `v` is part of the prefix.
 *
 * The defensive value here is small but real: today's floor matcher won't flag
 * `[shipped-in-v1.0]` because the `v` is lowercase and the letter set is
 * uppercase-only. A future tightening that also matches `v1` would. Exempting
 * the literal token now means that tightening cannot break in transit.
 */
const STATUS_MARKER_PREFIXES = ['[shipped-in-v', '[partial-v', '[deferred-to-v'];

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: lint-no-spec-ref [--scan-root <path>] [--project-root <path>]',
    '                        [--json] [--quiet] [--help]',
    '',
    'Walks <scan-root>/agents/ and all of <scan-root>/skills/gan/ and reports',
    'any line containing an internal phase-code reference (e.g. F4, C1\'s) or',
    'a specifications/<CODE> path. The EXAMPLES region of SKILL.md is exempt;',
    'lines containing a status-marker token ([shipped-in-v..], [partial-v..],',
    '[deferred-to-v..]) are exempt for the marker token only.',
    '',
    'Options:',
    '  --scan-root <path>       Inspect this scan root instead of the repo root.',
    '  --project-root <path>    Accepted for arg-parser compatibility; unused.',
    '  --json                   Emit the report as a JSON document on stdout.',
    '  --quiet                  Suppress the stdout summary on a clean run.',
    '  --help                   Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No references detected.',
    '  1  At least one reference detected outside the allowlist.',
    '  64 Unknown flag or other usage error.',
    '',
  ].join('\n');
}

/** What {@link run} returns: the text for each stream plus the process exit code. */
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Resolved options for {@link run}, produced by {@link main} from parsed argv.
 *
 * @property scanRoot root the scan scope is taken relative to (its `agents/`
 *   and `skills/gan/` subtrees are walked).
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  scanRoot: string;

  json: boolean;

  quiet: boolean;
}

/**
 * Recursively collect every `*.md` file under `dir`, in deterministic
 * locale-insensitive sort order so the report is reproducible run-to-run.
 *
 * Returns `[]` when `dir` is absent or not a directory, and silently skips any
 * entry that cannot be `stat`ed, so a partially-readable tree never aborts the
 * scan. Reads disk only.
 */
function walkMarkdown(dir: string): string[] {
  let entries: string[];
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  entries.sort();
  const files: string[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      files.push(...walkMarkdown(abs));
    } else if (st.isFile() && abs.endsWith('.md')) {
      files.push(abs);
    }
  }
  return files;
}

/**
 * Build the ordered list of files in the scan scope: every `agents/*.md`
 * (top-level only — agents are never nested) and every `*.md` under
 * `skills/gan/` (directory walk — the spec explicitly forbids a fixed file
 * list so a future addition like a second skill prompt is policed without an
 * edit here). Each segment is sorted independently and appended in a fixed
 * order so the file list is deterministic. Missing pieces of the scope are
 * skipped rather than erroring — the scope is a superset. Reads disk only.
 */
function listScanFiles(scanRoot: string): string[] {
  const files: string[] = [];

  // agents/ is a flat directory of *.md files in the shipped layout; a walk
  // would still be correct, but a single readdir matches the layout's
  // intent and avoids recursing into any future non-prompt subdirectory.
  const agentsDir = path.join(scanRoot, 'agents');
  try {
    const stat = statSync(agentsDir);
    if (stat.isDirectory()) {
      const entries = readdirSync(agentsDir).filter((e) => e.endsWith('.md'));
      entries.sort();
      for (const e of entries) {
        const abs = path.join(agentsDir, e);
        try {
          if (statSync(abs).isFile()) files.push(abs);
        } catch {
          // Unreadable entries are silently skipped — see walkMarkdown.
        }
      }
    }
  } catch {
    // Missing agents/ → skip.
  }

  // skills/gan/ is recursively walked; both SKILL.md and trust-prompt.md must
  // be covered, and the spec ties the scope to the directory rather than a
  // file list so a new prompt can land there without a separate lint edit.
  const skillDir = path.join(scanRoot, 'skills', 'gan');
  files.push(...walkMarkdown(skillDir));

  return files;
}

/**
 * Remove the `[shipped-in-v...]`, `[partial-v...]`, `[deferred-to-v...]`
 * status-marker token spans from `line`, replacing each span with spaces of
 * the same length. Same-length replacement is important: the matcher reports
 * column numbers, so collapsing the span would mis-align every subsequent
 * column on the line. The status-marker allowlist is defensive against a
 * future tightening of the matcher; today's floor matcher does not flag the
 * markers, but the test suite asserts the allowlist works either way.
 */
function stripStatusMarkers(line: string): string {
  let out = line;
  for (const prefix of STATUS_MARKER_PREFIXES) {
    let idx = 0;
    while ((idx = out.indexOf(prefix, idx)) !== -1) {
      const end = out.indexOf(']', idx + prefix.length);
      if (end === -1) break;
      const span = end - idx + 1;
      out = out.slice(0, idx) + ' '.repeat(span) + out.slice(end + 1);
      idx = end + 1;
    }
  }
  return out;
}

/**
 * One reported match: the issue code, the matched substring, and the 1-based
 * line and column for human-readable output.
 */
interface MatchHit {
  code: string;
  match: string;
  line: number;
  column: number;
}

/**
 * Scan one file's text for both matchers, honouring the EXAMPLES-region exempt
 * on `SKILL.md` and the per-line status-marker exempt. Returns the ordered hit
 * list (top-of-file first). Pure.
 *
 * The EXAMPLES region is detected by trimmed-line equality with the literal
 * `EXAMPLES` head and an enclosing set of section-tail tokens
 * (`CONFIGURATION`, `OUTPUT`, …). The check runs only on the file whose
 * basename is `SKILL.md`; other files have no example region.
 *
 * @param fileBaseName the file's basename (e.g. `SKILL.md`), used to decide
 *   whether to apply the EXAMPLES-region exempt.
 * @param text the full file contents.
 */
function findHits(fileBaseName: string, text: string): MatchHit[] {
  const hits: MatchHit[] = [];
  const lines = text.split(/\r?\n/);
  const skillExamplesExempt = fileBaseName === SKILL_FILE_BASENAME;

  let inExamplesRegion = false;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // EXAMPLES-region state machine: a SKILL.md-only sentinel pair. The head
    // line carries the literal `EXAMPLES`; the tail is any of a known set of
    // sibling-section headings inside the same help text. Entering or leaving
    // the region on the sentinel line itself also exempts that line — the
    // sentinel is part of the example block by intent.
    if (skillExamplesExempt) {
      if (!inExamplesRegion && trimmed === EXAMPLES_HEAD_LINE) {
        inExamplesRegion = true;
        continue;
      }
      if (inExamplesRegion && EXAMPLES_TAIL_LINES.has(trimmed)) {
        inExamplesRegion = false;
        continue;
      }
      if (inExamplesRegion) continue;
    }

    // Apply the per-line status-marker exempt by removing the marker token's
    // span before running either matcher. The replacement is space-padded to
    // preserve column alignment for the matcher's column reporting.
    const matchable = stripStatusMarkers(rawLine);

    // Reset each regex's lastIndex per line so the global flag's stateful
    // position does not bleed across lines.
    PHASE_CODE_REGEX.lastIndex = 0;
    SPEC_PATH_REGEX.lastIndex = 0;

    // Path matches are reported first because they are the more specific
    // citation form; a single line carrying both shows the path hit first.
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = SPEC_PATH_REGEX.exec(matchable)) !== null) {
      hits.push({
        code: SPEC_PATH_REFERENCE_CODE,
        match: pathMatch[0],
        line: i + 1,
        column: pathMatch.index + 1,
      });
    }

    let phaseMatch: RegExpExecArray | null;
    while ((phaseMatch = PHASE_CODE_REGEX.exec(matchable)) !== null) {
      hits.push({
        code: PHASE_CODE_REFERENCE_CODE,
        match: phaseMatch[0],
        line: i + 1,
        column: phaseMatch.index + 1,
      });
    }
  }
  return hits;
}

/**
 * Scan the shipped surface for phase-code and spec-path references and return
 * a rendered {@link RunResult}.
 *
 * No file is exempt at the whole-file level; the EXAMPLES region in
 * `SKILL.md` and the per-line status-marker exempt are the only allowlists.
 * Exit code is `SUCCESS` with no failures, else `FAILURE`. Read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];

  const files = listScanFiles(opts.scanRoot);
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Listed but now unreadable: skip rather than fail — the file was
      // present at enumeration, so a transient read error is not a finding.
      continue;
    }
    const hits = findHits(path.basename(abs), text);
    for (const hit of hits) {
      const detailMessage =
        hit.code === SPEC_PATH_REFERENCE_CODE
          ? `internal spec-path reference '${hit.match}' detected at ${abs}:${hit.line}:${hit.column}. ` +
            `The shipped surface runs against end-user repos that have no specifications/ directory; ` +
            `inline the rule or reword the prose instead of citing the path.`
          : `internal phase-code reference '${hit.match}' detected at ${abs}:${hit.line}:${hit.column}. ` +
            `Phase codes are repo-development vocabulary; state the rule inline rather than citing the code.`;
      failures.push({
        path: abs,
        code: hit.code,
        message: detailMessage,
      });
    }
  }

  // Re-use the lint-no-stack-leak report shape: same `kind` discriminator means
  // the existing formatters can render the human summary and JSON output with
  // no schema change. The shape is a `files scanned / hits` tally, which is the
  // right framing here too — one file can carry several distinct references,
  // and each is independently actionable.
  const report: LintNoStackLeakReport = {
    kind: 'lint-no-stack-leak',
    checked: files.length,
    failures,
  };
  return finalize(report, opts);
}

/**
 * Turn a finished report into a {@link RunResult}: render it (JSON vs. human),
 * suppress the clean-run stdout summary under `--quiet`, and derive the exit
 * code (`SUCCESS` iff there are no failures, else `FAILURE`). Pure.
 */
function finalize(report: LintNoStackLeakReport, opts: RunOptions): RunResult {
  if (opts.json) {
    return {
      stdout: formatReportJson(report),
      stderr: '',
      code: report.failures.length === 0 ? SCRIPT_EXIT.SUCCESS : SCRIPT_EXIT.FAILURE,
    };
  }
  const formatted = formatReport(report);
  const stdout = opts.quiet && report.failures.length === 0 ? '' : formatted.stdout;
  return {
    stdout,
    stderr: formatted.stderr,
    code: report.failures.length === 0 ? SCRIPT_EXIT.SUCCESS : SCRIPT_EXIT.FAILURE,
  };
}

/**
 * CLI entrypoint: parse argv, dispatch to {@link run}, and write its output.
 *
 * Returns the exit code rather than calling `process.exit`, so it is testable
 * in-process. `--help` short-circuits with `SUCCESS`; an unknown flag or
 * unexpected positional returns `BAD_ARGS` before scanning. `--scan-root` is
 * resolved to an absolute path; `--project-root` is accepted for compatibility
 * with the shared parser but is not used here. Side effect: writes to
 * stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help'],
    string: ['project-root', 'scan-root'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`lint-no-spec-ref --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`lint-no-spec-ref --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const scanRoot =
    typeof parsed.flags['scan-root'] === 'string'
      ? path.resolve(parsed.flags['scan-root'] as string)
      : repoRoot;

  const result = run({
    scanRoot,
    json: parsed.flags['json'] === true,
    quiet: parsed.flags['quiet'] === true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

// Module-level invocation: run as a script and translate the resolved exit
// code into the actual process exit. The rejection arm is the last-resort net
// for an *unexpected* throw (anticipated failures are already returned as a
// report); it prints a `fatal:` line and exits FAILURE so an uncaught error
// can never masquerade as success.
main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`lint-no-spec-ref: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

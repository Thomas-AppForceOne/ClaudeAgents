#!/usr/bin/env node
/**
 * `lint-status-markers` CLI — enforces status-marker discipline on the gan
 * skill prose.
 *
 * The gan skill documents both runtime behaviour that ships in the current
 * release and forward-looking behaviour reserved for a future release. The
 * orchestrator's dispatch is driven off these `[shipped-in-vX.Y]` /
 * `[partial-vX.Y]` / `[deferred-to-vX.Y]` markers, so a section without a
 * marker leaves the runtime contract genuinely ambiguous: a sub-agent reading
 * the prose cannot tell whether to dispatch normally or short-circuit with
 * the "requires a later release" refusal. This script asserts two related
 * invariants on `skills/gan/SKILL.md`:
 *
 * 1. Every runtime-behaviour level-2 (`## …`) section heading carries a
 *    marker, either on the heading itself or — for a heading that shares two
 *    or more sibling flags of differing status — via per-flag markers in the
 *    section body. The per-flag exemption is what lets one combined heading
 *    cover, say, an in-release flow and a deferred companion without forcing
 *    an artificial heading split that would scatter related prose.
 *
 * 2. Every marker token references a release that is present in the roadmap.
 *    The release set is read off the roadmap's `## vX.Y …` headings so a
 *    marker like `[shipped-in-v9.9]` is rejected the moment the release is
 *    not enumerated — the lint stays honest without a hardcoded version list
 *    a real release would have to update by hand.
 *
 * What the lint does NOT verify is whether a `[shipped-in-vX.Y]`-marked flow
 * actually runs; that is the release-gate dogfood's job. The scan here is
 * pure-deterministic: read the file, walk the headings, validate the markers,
 * stop. No subprocess, no network, no agent spawn.
 *
 * Output and exit follow the shared `scripts/lib` contract (`0`/`1`/`64`),
 * and the report is rendered through the existing leak-style summary so the
 * human and JSON shapes match the other lints in the harness. `run` is
 * exported and read-only; `main` owns argv and process I/O.
 */
import { readFileSync, statSync } from 'node:fs';
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
 * Stable issue code for a runtime-behaviour level-2 heading that carries no
 * marker on the heading and has no qualifying per-flag markers in its body.
 * Tests and CI match on this constant so a wording change in the human
 * message does not break either.
 */
export const MISSING_STATUS_MARKER_CODE = 'MissingStatusMarker';

/**
 * Stable issue code for a marker whose release segment is absent from the
 * roadmap (`[shipped-in-v9.9]` against a roadmap that enumerates only
 * `v1.0` / `v1.1` / `v1.2` / `v2.0`). Distinct from the missing-heading code
 * so a consumer can tell prose-omission drift from release-citation drift.
 */
export const UNKNOWN_RELEASE_IN_MARKER_CODE = 'UnknownReleaseInMarker';

// Repo root derived from this compiled module's location (dist/scripts/...),
// so the default scan target and roadmap path resolve regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

// Default scan target is the single gan SKILL file. The spec deliberately
// names one file (no recursive walk of `skills/gan/`) — widening the scope
// would catch sibling prompts that intentionally carry no markers, like the
// trust prompt, and produce noise the user cannot resolve without editing a
// prompt that has nothing to do with release-status discipline.
const DEFAULT_SKILL_RELATIVE = path.join('skills', 'gan', 'SKILL.md');

// Default roadmap path — the single source of truth for the release set.
// Splitting "what files to scan" from "where to read the release set" lets
// tests plant a temp scan-root with its own roadmap fixture without having
// to also build the production scan tree.
const DEFAULT_ROADMAP_RELATIVE = path.join('specifications', 'roadmap.md');

/**
 * Marker-token regex. Captures the release segment so the validator can match
 * it against the roadmap's enumerated set. Three kinds match (`shipped-in`,
 * `partial`, `deferred-to`) because they are the three operative marker forms
 * the orchestrator dispatch reads; widening to additional kinds would silently
 * accept a marker the runtime does not understand.
 */
const MARKER_TOKEN_REGEX = /\[(shipped-in|partial|deferred-to)-v(\d+\.\d+)\]/g;

/**
 * Roadmap release heading regex. Releases are level-2 headings whose text
 * begins `vX.Y` (`## v1.0 — first release`); the version segment is captured.
 * The em-dash suffix is allowed but not required, so a roadmap that later
 * drops the descriptive tail keeps validating without an edit here.
 */
const ROADMAP_RELEASE_HEADING_REGEX = /^##\s+v(\d+\.\d+)(?:\b|\s|$)/;

/**
 * Level-2 heading regex on a Markdown line. Captures the heading text
 * (everything after the `## ` prefix) so the marker-on-heading check can run
 * against the rendered title rather than the raw line.
 */
const LEVEL_TWO_HEADING_REGEX = /^##\s+(.+?)\s*$/;

/**
 * Per-flag-marker pair regex: a `--<flag>` token followed within a short
 * span by a status-marker token. The character budget between the flag and
 * the marker is bounded because we want a marker that visibly belongs to
 * the flag mention — a marker many sentences later is not what the
 * "per-flag marker" exemption was written for. The `[^\n]{0,200}` cap is
 * generous enough to absorb a backtick-wrapped flag and a descriptive
 * preamble while still excluding cross-paragraph mismatches.
 */
const FLAG_WITH_MARKER_REGEX =
  /--[a-zA-Z][a-zA-Z0-9-]*[^\n]{0,200}?\[(?:shipped-in|partial|deferred-to)-v\d+\.\d+\]/g;

/**
 * The exemption threshold for the multi-flag-shared-heading rule. A heading
 * that documents two-or-more sibling flags of differing status is exempt
 * from the heading-marker requirement when at least this many per-flag
 * marker pairs appear in its section body. Two is the minimum count that
 * actually identifies a *multi*-flag section; one pair is consistent with a
 * single-flag section that simply forgot the heading marker, so requiring
 * two avoids accepting that drift mode as exempt.
 */
const MULTI_FLAG_THRESHOLD = 2;

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: lint-status-markers [--scan-root <path>] [--roadmap <path>]',
    '                           [--project-root <path>]',
    '                           [--json] [--quiet] [--help]',
    '',
    'Checks the gan skill prose for status-marker discipline. Every',
    'runtime-behaviour level-2 heading must carry a marker (or qualify for',
    'the multi-flag exemption via per-flag markers in the section body), and',
    'every marker must reference a release present in the roadmap.',
    '',
    'Options:',
    '  --scan-root <path>       Inspect this scan root instead of the repo root.',
    '                           The lint reads <scan-root>/skills/gan/SKILL.md.',
    '  --roadmap <path>         Read the release set from this file instead of',
    '                           <scan-root>/specifications/roadmap.md.',
    '  --project-root <path>    Accepted for arg-parser compatibility; unused.',
    '  --json                   Emit the report as a JSON document on stdout.',
    '  --quiet                  Suppress the stdout summary on a clean run.',
    '  --help                   Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No findings.',
    '  1  At least one missing or unknown-release marker.',
    '  64 Unknown flag or other usage error.',
    '',
  ].join('\n');
}

/** What {@link run} returns: the text for each stream plus the process exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Resolved options for {@link run}, produced by {@link main} from parsed argv.
 *
 * @property scanRoot root the scan scope is taken relative to; the lint reads
 *   `<scanRoot>/skills/gan/SKILL.md`. Tests pass a temp directory here to
 *   plant fixture content without touching the live worktree.
 * @property roadmapPath absolute path to the roadmap file the release set is
 *   read from. Defaults to `<scanRoot>/specifications/roadmap.md`; tests can
 *   override it so a planted SKILL fixture can be evaluated against a
 *   planted roadmap fixture without rebuilding both trees.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
export interface RunOptions {
  scanRoot: string;

  roadmapPath: string;

  json: boolean;

  quiet: boolean;
}

/**
 * Read every release version from a roadmap file. A release is any line that
 * matches `## vX.Y` (the level-2 heading shape the roadmap uses for releases);
 * the captured `X.Y` is added to the returned set. A missing or unreadable
 * roadmap returns the empty set rather than throwing — the downstream rule
 * will then reject every marker, which is the right failure mode for a
 * caller who pointed at no roadmap at all. Pure; reads disk once.
 *
 * @param roadmapPath absolute path to the roadmap file.
 * @returns set of `"X.Y"` release segments.
 */
function readRoadmapReleases(roadmapPath: string): Set<string> {
  const releases = new Set<string>();
  let text: string;
  try {
    text = readFileSync(roadmapPath, 'utf8');
  } catch {
    // A roadmap that cannot be read leaves the release set empty. Every
    // marker then fails the unknown-release rule, which is what we want a
    // misconfigured invocation to surface rather than silently passing.
    return releases;
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = ROADMAP_RELEASE_HEADING_REGEX.exec(line);
    if (match) {
      releases.add(match[1]!);
    }
  }
  return releases;
}

/**
 * One level-2 section extracted from the SKILL prose: its heading line, the
 * heading text (rendered, sans `## ` prefix), and the section body up to but
 * not including the next level-2 heading. Section bodies are what the
 * multi-flag exemption inspects.
 */
interface Section {
  headingLine: number;
  headingText: string;
  body: string;
}

/**
 * Split a Markdown document into its level-2 sections. The split is shallow:
 * level-3 (`### …`) headings stay inside the parent section's body, which is
 * deliberate — the marker discipline this lint enforces is a level-2 contract.
 * Pure.
 */
function splitLevelTwoSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  let bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const headingMatch = LEVEL_TWO_HEADING_REGEX.exec(line);
    if (headingMatch) {
      if (current) {
        current.body = bodyLines.join('\n');
        sections.push(current);
      }
      current = {
        headingLine: i + 1,
        headingText: headingMatch[1]!,
        body: '',
      };
      bodyLines = [];
      continue;
    }
    if (current) {
      bodyLines.push(line);
    }
  }
  if (current) {
    current.body = bodyLines.join('\n');
    sections.push(current);
  }
  return sections;
}

/**
 * Extract every marker token from `text`, returning each captured release
 * segment along with the full token's start offset relative to `text`. The
 * offset is used by the unknown-release reporter to produce a precise
 * column number even when the marker occurs mid-line. Pure.
 */
function extractMarkers(text: string): Array<{ token: string; release: string; offset: number }> {
  const out: Array<{ token: string; release: string; offset: number }> = [];
  // Reset lastIndex so the global flag's stateful position does not leak
  // across calls and skip an early match on a re-entry.
  MARKER_TOKEN_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_TOKEN_REGEX.exec(text)) !== null) {
    out.push({ token: m[0], release: m[2]!, offset: m.index });
  }
  return out;
}

/**
 * Count per-flag marker pairs in `body`. A pair is a `--<flag>` token
 * followed within {@link FLAG_WITH_MARKER_REGEX}'s short span by a marker
 * token; this is what the multi-flag exemption looks for. Pure.
 */
function countFlagMarkerPairs(body: string): number {
  FLAG_WITH_MARKER_REGEX.lastIndex = 0;
  let count = 0;
  while (FLAG_WITH_MARKER_REGEX.exec(body) !== null) {
    count += 1;
  }
  return count;
}

/**
 * Translate a byte offset into a 1-based (line, column) pair against `text`,
 * counting `\n` as the newline. Used only to produce stable position info
 * for unknown-release findings; the line/column are reported in the human
 * message so a reviewer can jump straight to the offending token. Pure.
 */
function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

/**
 * Apply both rules to one SKILL file's contents and return the ordered
 * failure list. The heading rule runs first (so a missing-heading finding
 * leads a multi-finding file), the release rule second. Pure.
 *
 * @param filePath absolute path used as the failure `path` field.
 * @param text full file contents.
 * @param releases set of versions accepted by the unknown-release rule.
 */
function lintSkill(
  filePath: string,
  text: string,
  releases: ReadonlySet<string>,
): ReportFailure[] {
  const failures: ReportFailure[] = [];

  // Rule 1: every level-2 heading must carry a marker on the heading itself
  // or qualify for the multi-flag exemption via per-flag body markers. The
  // exemption exists because a single combined heading sometimes covers two
  // sibling flags of differing status; forcing a heading split there would
  // scatter related prose across two sections without changing the runtime
  // contract.
  const sections = splitLevelTwoSections(text);
  for (const section of sections) {
    const headingMarkers = extractMarkers(section.headingText);
    if (headingMarkers.length > 0) {
      continue;
    }
    const pairCount = countFlagMarkerPairs(section.body);
    if (pairCount >= MULTI_FLAG_THRESHOLD) {
      continue;
    }
    failures.push({
      path: filePath,
      code: MISSING_STATUS_MARKER_CODE,
      message:
        `runtime-behaviour heading '${section.headingText}' at ${filePath}:${section.headingLine} ` +
        `carries no status marker and the section body contains fewer than ${MULTI_FLAG_THRESHOLD} ` +
        `per-flag markers. Add a heading marker like '[shipped-in-v<release>]' or attach a marker ` +
        `to each sibling --flag mention so the runtime contract is unambiguous.`,
    });
  }

  // Rule 2: every marker token must reference a release present in the
  // roadmap. The roadmap is the single source of truth; hardcoding a release
  // list would force a release-cut PR to edit the lint instead of the
  // roadmap, and a stale lint would then silently accept a marker no
  // dispatch can act on.
  const markers = extractMarkers(text);
  for (const marker of markers) {
    if (releases.has(marker.release)) {
      continue;
    }
    const { line, column } = offsetToLineCol(text, marker.offset);
    failures.push({
      path: filePath,
      code: UNKNOWN_RELEASE_IN_MARKER_CODE,
      message:
        `marker '${marker.token}' at ${filePath}:${line}:${column} references release ` +
        `v${marker.release}, which is not enumerated in the roadmap. Add the release to the ` +
        `roadmap (as a '## v${marker.release} …' heading) or correct the marker to cite a ` +
        `release that is present.`,
    });
  }

  return failures;
}

/**
 * Enumerate the files the lint will scan under `scanRoot`. The default is the
 * single gan SKILL file; if a future caller adds a sibling skill that opts
 * into markers we add it explicitly here rather than walk the directory,
 * because every other prompt under `skills/gan/` is intentionally exempt
 * from the marker discipline. Returns an empty list if the SKILL file is
 * absent — a tests' temp scan-root that planted no fixture under
 * `skills/gan/` is reported as zero files scanned rather than an error.
 */
function listScanFiles(scanRoot: string): string[] {
  const files: string[] = [];
  const skillFile = path.join(scanRoot, DEFAULT_SKILL_RELATIVE);
  try {
    if (statSync(skillFile).isFile()) {
      files.push(skillFile);
    }
  } catch {
    // Missing SKILL.md → skip; the report will show zero files scanned.
  }
  return files;
}

/**
 * Scan the SKILL prose for missing or unknown-release markers and return a
 * rendered {@link RunResult}. The roadmap is read once at the top so a file
 * with many markers does not re-read it per marker. Read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const releases = readRoadmapReleases(opts.roadmapPath);
  const failures: ReportFailure[] = [];
  const files = listScanFiles(opts.scanRoot);
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Listed but unreadable: skip rather than fail — the file was present
      // at enumeration, so a transient read error is not a finding.
      continue;
    }
    failures.push(...lintSkill(abs, text, releases));
  }

  // Re-use the leak-style report shape so the existing human and JSON
  // formatters render this lint identically to its siblings; adding a
  // bespoke `kind` would force the shared lib to grow a new formatter for
  // no behavioural gain. The shape is a `files scanned / hits` tally, which
  // is the right framing here too — one file can carry several findings,
  // each independently actionable.
  const report: LintNoStackLeakReport = {
    kind: 'lint-no-stack-leak',
    checked: files.length,
    failures,
  };
  return finalize(report, opts);
}

/**
 * Turn a finished report into a {@link RunResult}: render it (JSON vs.
 * human), suppress the clean-run stdout summary under `--quiet`, and derive
 * the exit code (`SUCCESS` iff there are no failures, else `FAILURE`). Pure.
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
 * unexpected positional returns `BAD_ARGS` before scanning. `--scan-root`
 * and `--roadmap` are resolved to absolute paths; `--project-root` is
 * accepted for arg-parser compatibility but is not used here. Side effect:
 * writes to stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 * @returns one of `SUCCESS`, `FAILURE`, or `BAD_ARGS`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help'],
    string: ['project-root', 'scan-root', 'roadmap'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`lint-status-markers --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`lint-status-markers --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const scanRoot =
    typeof parsed.flags['scan-root'] === 'string'
      ? path.resolve(parsed.flags['scan-root'] as string)
      : repoRoot;

  // The roadmap default is derived from the scan-root, not the repo root: a
  // test that plants a SKILL fixture under a temp scan-root expects the
  // roadmap to come from the same fixture tree unless explicitly overridden.
  const roadmapPath =
    typeof parsed.flags['roadmap'] === 'string'
      ? path.resolve(parsed.flags['roadmap'] as string)
      : path.join(scanRoot, DEFAULT_ROADMAP_RELATIVE);

  const result = run({
    scanRoot,
    roadmapPath,
    json: parsed.flags['json'] === true,
    quiet: parsed.flags['quiet'] === true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

// Module-level invocation: run as a script and translate the resolved exit
// code into the actual process exit. The rejection arm is the last-resort
// net for an *unexpected* throw (anticipated failures are already returned
// as a report); it prints a `fatal:` line and exits FAILURE so an uncaught
// error can never masquerade as success.
main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`lint-status-markers: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

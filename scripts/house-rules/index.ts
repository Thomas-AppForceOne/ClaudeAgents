#!/usr/bin/env node
/**
 * `house-rules` CLI — locks the byte-identity of the three named house-rules
 * fragments across every shipped agent file, plus the structural validity of
 * each agent's subagent frontmatter.
 *
 * The shipped agents are self-contained at runtime: the three load-bearing
 * fragments (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`) are inlined
 * verbatim into each `agents/*.md` at its natural position, delimited by named
 * sentinel pairs (`<!-- hr:<name>:start --> ... <!-- hr:<name>:end -->`).
 * Without a parity check, a maintainer reading two agents side-by-side might
 * "fix" a typo in one and forget the others; the three fragments would then
 * silently drift apart. This script is the durable backstop against that —
 * it reads the canonical partial at `scripts/house-rules/house-rules.md`,
 * extracts its three named fragment bodies, and asserts every agent's
 * correspondingly-named region is byte-identical.
 *
 * Frontmatter is checked alongside parity because both checks read the same
 * file set; running them together costs one disk walk instead of two and the
 * failure modes are complementary (parity drift vs. missing top-of-file
 * metadata). The frontmatter check is structural only: the keys `name`,
 * `description`, and `tools` must be present and non-empty; `model` is
 * optional. The script does not validate the value beyond non-emptiness —
 * deeper validation is the orchestrator's territory, not the parity check's.
 *
 * Each finding names the agent file and the region or frontmatter field it
 * concerns. Exit codes follow the shared `scripts/lib` contract (`0`/`1`/`64`).
 * `run` is exported and read-only; `main` owns argv and process I/O.
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

/** Stable issue codes — tests and CI match on these, not on the literal message. */
const PARTIAL_UNREADABLE_CODE = 'HouseRulesPartialUnreadable';
const REGION_MISSING_CODE = 'HouseRulesRegionMissing';
const REGION_DUPLICATED_CODE = 'HouseRulesRegionDuplicated';
const REGION_REORDERED_CODE = 'HouseRulesRegionReordered';
const REGION_DRIFT_CODE = 'HouseRulesRegionDrift';
const FRONTMATTER_MISSING_CODE = 'AgentFrontmatterMissing';
const FRONTMATTER_FIELD_MISSING_CODE = 'AgentFrontmatterFieldMissing';
const FRONTMATTER_FIELD_EMPTY_CODE = 'AgentFrontmatterFieldEmpty';

// Repo root derived from this compiled module's location (dist/scripts/...),
// so the default partial path resolves regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * The three named fragment IDs. Order is the order they are checked per file
 * (top-of-file forward) — a deterministic order matters because each finding
 * is independently actionable and a stable order makes the report easier to
 * scan run-to-run.
 */
const FRAGMENT_NAMES = ['hr:snapshot', 'hr:no-config-api', 'hr:errors-tail'] as const;
type FragmentName = (typeof FRAGMENT_NAMES)[number];

/**
 * Required subagent frontmatter fields. `model` is optional — the orchestrator
 * supplies a default when absent — and is intentionally NOT checked here.
 * Treating it as required would force every agent file to carry an explicit
 * model pin even when the default is correct; the parity check is structural,
 * not policy.
 */
const REQUIRED_FRONTMATTER_FIELDS = ['name', 'description', 'tools'] as const;

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: house-rules [--scan-root <path>] [--partial-file <path>]',
    '                   [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Walks <scan-root>/agents/*.md and asserts (a) each file\'s three named',
    'house-rules regions (hr:snapshot, hr:no-config-api, hr:errors-tail) are',
    'byte-identical to the canonical partial at scripts/house-rules/',
    'house-rules.md and (b) each file\'s subagent frontmatter carries name,',
    'description, and tools as non-empty fields.',
    '',
    'Options:',
    '  --scan-root <path>       Inspect this scan root instead of the repo root.',
    '  --partial-file <path>    Override the canonical partial path (testing).',
    '  --project-root <path>    Accepted for arg-parser compatibility; unused.',
    '  --json                   Emit the report as a JSON document on stdout.',
    '  --quiet                  Suppress the stdout summary on a clean run.',
    '  --help                   Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  All regions byte-identical and all frontmatter valid.',
    '  1  At least one drift, missing region, or frontmatter defect detected.',
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
 * @property scanRoot root whose `agents/` subtree is walked.
 * @property partialFile absolute path to the canonical house-rules partial.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  scanRoot: string;

  partialFile: string;

  json: boolean;

  quiet: boolean;
}

/**
 * Extract the body text between a named sentinel pair from `text`. The body
 * excludes the sentinel lines themselves — only the lines strictly between
 * them are returned, joined with `\n` (no trailing newline). The choice of
 * named sentinel pairs (one per fragment) rather than a single contiguous
 * block is load-bearing: the fragments sit at different natural positions
 * in each agent (snapshot lives in `## Inputs`, no-config-api in the
 * prohibition section, errors-tail at the end of `## Errors`), so a single
 * contiguous block would force every agent into the same layout.
 *
 * Returns one of:
 * - `{ status: 'ok', body }` — exactly one sentinel pair, properly ordered.
 * - `{ status: 'missing' }` — at least one sentinel is absent.
 * - `{ status: 'reordered' }` — both sentinels present but `:end` appears
 *   before its matching `:start`.
 * - `{ status: 'duplicated' }` — more than one start or more than one end
 *   for this name.
 *
 * Pure: parses `text` and returns the result; no I/O or mutation.
 */
type ExtractResult =
  | { status: 'ok'; body: string }
  | { status: 'missing' }
  | { status: 'reordered' }
  | { status: 'duplicated' };

function extractFragment(text: string, name: FragmentName): ExtractResult {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const lines = text.split(/\r?\n/);

  const startIdxs: number[] = [];
  const endIdxs: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === startMarker) startIdxs.push(i);
    if (trimmed === endMarker) endIdxs.push(i);
  }

  if (startIdxs.length === 0 || endIdxs.length === 0) {
    return { status: 'missing' };
  }
  if (startIdxs.length > 1 || endIdxs.length > 1) {
    return { status: 'duplicated' };
  }
  const startIdx = startIdxs[0]!;
  const endIdx = endIdxs[0]!;
  if (endIdx <= startIdx) {
    return { status: 'reordered' };
  }
  const bodyLines = lines.slice(startIdx + 1, endIdx);
  return { status: 'ok', body: bodyLines.join('\n') };
}

/** Each fragment body extracted from the canonical partial, keyed by name. */
type PartialFragments = Record<FragmentName, string>;

/**
 * Read the canonical partial and extract all three fragment bodies. Returns
 * `null` when the partial is unreadable or any fragment is missing — both
 * conditions are unrecoverable for the parity check and short-circuit the
 * scan with a single `HouseRulesPartialUnreadable` finding rather than
 * misleading per-agent findings.
 *
 * Reads disk; otherwise pure.
 */
function readPartial(partialFile: string): PartialFragments | null {
  let text: string;
  try {
    text = readFileSync(partialFile, 'utf8');
  } catch {
    return null;
  }
  const out = {} as PartialFragments;
  for (const name of FRAGMENT_NAMES) {
    const extracted = extractFragment(text, name);
    if (extracted.status !== 'ok') {
      return null;
    }
    out[name] = extracted.body;
  }
  return out;
}

/**
 * List every `*.md` file directly under `<scanRoot>/agents/`, sorted
 * deterministically. Returns `[]` when `agents/` is absent or not a directory,
 * so the script still runs (and reports zero findings) against a scan root
 * that has not yet authored agents. Reads disk only.
 *
 * The filter is `*.md` (not a fixed file list) so the check fires the moment a
 * new agent lands; this is the "future drift" arm of the parity test, the
 * complementary defense to the parity check itself.
 */
function listAgentFiles(scanRoot: string): string[] {
  const agentsDir = path.join(scanRoot, 'agents');
  let entries: string[];
  try {
    const stat = statSync(agentsDir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  entries = entries.filter((e) => e.endsWith('.md'));
  entries.sort();
  const out: string[] = [];
  for (const e of entries) {
    const abs = path.join(agentsDir, e);
    try {
      if (statSync(abs).isFile()) out.push(abs);
    } catch {
      // Unreadable entries are silently skipped.
    }
  }
  return out;
}

/**
 * Parse the YAML frontmatter block from `text` and return its keyed fields, or
 * `null` if the file lacks a frontmatter block.
 *
 * The parse is deliberately minimal: it locates the first `---` line at the
 * top of the file, the next `---` line, and returns the lines between them
 * parsed as `key: value` pairs. A more thorough parser is unnecessary here —
 * the parity script only asserts presence and non-emptiness of three keys,
 * so it does not need YAML semantics (lists, nested objects, quoting). The
 * `tools` field in shipped agents is a comma-separated string (e.g.
 * `Read, Write, Bash`); the parser returns the raw value verbatim.
 *
 * Pure.
 */
function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== '---') return null;
  // Find the closing `---` somewhere after line 0.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;

  const out: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i]!;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Check every parity + frontmatter rule against the scan-root's agent files
 * and return a rendered {@link RunResult}.
 *
 * Algorithm: read the canonical partial; for each agent file, extract each
 * fragment region and compare to the partial fragment, then validate the
 * frontmatter. Per-agent findings are appended in deterministic order
 * (frontmatter findings first per file, then region findings in fragment
 * order). Exit code is `SUCCESS` with no failures, else `FAILURE`. Read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];

  const partial = readPartial(opts.partialFile);
  if (partial === null) {
    // Unrecoverable: every per-agent finding would mislead because the
    // expected fragment bodies are unknown. Short-circuit with a single,
    // honest failure that names the canonical partial path.
    failures.push({
      path: opts.partialFile,
      code: PARTIAL_UNREADABLE_CODE,
      message:
        `canonical house-rules partial at ${opts.partialFile} could not be read or is missing one ` +
        `of the named fragments (${FRAGMENT_NAMES.join(', ')}). Restore the file from version control ` +
        `before re-running.`,
    });
    const report: LintNoStackLeakReport = {
      kind: 'lint-no-stack-leak',
      checked: 0,
      failures,
    };
    return finalize(report, opts);
  }

  const files = listAgentFiles(opts.scanRoot);
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Listed but now unreadable: skip rather than fail — the file was
      // present at enumeration, so a transient read error is not a finding.
      continue;
    }

    const frontmatter = parseFrontmatter(text);
    if (frontmatter === null) {
      failures.push({
        path: abs,
        code: FRONTMATTER_MISSING_CODE,
        message:
          `subagent frontmatter not found in ${abs}. Every shipped agent file must open with a ` +
          `'---' / '---' YAML frontmatter block declaring name, description, and tools.`,
      });
    } else {
      for (const field of REQUIRED_FRONTMATTER_FIELDS) {
        if (!(field in frontmatter)) {
          failures.push({
            path: abs,
            field,
            code: FRONTMATTER_FIELD_MISSING_CODE,
            message:
              `subagent frontmatter in ${abs} is missing required field '${field}'. Add a '${field}: ...' ` +
              `line inside the frontmatter block.`,
          });
        } else if (frontmatter[field]!.length === 0) {
          failures.push({
            path: abs,
            field,
            code: FRONTMATTER_FIELD_EMPTY_CODE,
            message:
              `subagent frontmatter in ${abs} has empty value for required field '${field}'. ` +
              `Populate '${field}: ...' with a non-empty value.`,
          });
        }
      }
    }

    for (const name of FRAGMENT_NAMES) {
      const extracted = extractFragment(text, name);
      if (extracted.status === 'missing') {
        failures.push({
          path: abs,
          field: name,
          code: REGION_MISSING_CODE,
          message:
            `house-rules region '${name}' is missing from ${abs}. Restore the sentinel pair ` +
            `'<!-- ${name}:start --> ... <!-- ${name}:end -->' around the canonical fragment body.`,
        });
      } else if (extracted.status === 'reordered') {
        failures.push({
          path: abs,
          field: name,
          code: REGION_REORDERED_CODE,
          message:
            `house-rules region '${name}' in ${abs} has its ':end' sentinel before its ':start' sentinel. ` +
            `Reorder so ':start' appears first, with the canonical fragment body between them.`,
        });
      } else if (extracted.status === 'duplicated') {
        failures.push({
          path: abs,
          field: name,
          code: REGION_DUPLICATED_CODE,
          message:
            `house-rules region '${name}' appears more than once in ${abs}. Keep exactly one sentinel ` +
            `pair per region; remove the duplicate.`,
        });
      } else if (extracted.body !== partial[name]) {
        failures.push({
          path: abs,
          field: name,
          code: REGION_DRIFT_CODE,
          message:
            `house-rules region '${name}' in ${abs} drifted from the canonical partial. Restore the body ` +
            `between the sentinels to byte-match the corresponding fragment in scripts/house-rules/house-rules.md.`,
        });
      }
    }
  }

  // Re-use the lint-no-stack-leak report shape: the existing formatter renders
  // a `files scanned / hits` tally, which is the right framing here — one
  // agent file can carry several independently-actionable findings (frontmatter
  // + multiple region drifts), and reporting raw hit counts makes that visible.
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
 * unexpected positional returns `BAD_ARGS` before scanning. `--scan-root` and
 * `--partial-file` are resolved to absolute paths; `--project-root` is
 * accepted for compatibility with the shared parser but is not used here.
 * Side effect: writes to stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help'],
    string: ['project-root', 'scan-root', 'partial-file'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`house-rules --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`house-rules --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const scanRoot =
    typeof parsed.flags['scan-root'] === 'string'
      ? path.resolve(parsed.flags['scan-root'] as string)
      : repoRoot;

  // The default partial lives at scripts/house-rules/house-rules.md relative
  // to the scan root, so a hermetic test fixture can plant its own partial
  // there and override neither flag. The explicit `--partial-file` flag is
  // available for tests that want to keep the partial outside the scan tree.
  const partialFile =
    typeof parsed.flags['partial-file'] === 'string'
      ? path.resolve(parsed.flags['partial-file'] as string)
      : path.join(scanRoot, 'scripts', 'house-rules', 'house-rules.md');

  const result = run({
    scanRoot,
    partialFile,
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
    process.stderr.write(`house-rules: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

#!/usr/bin/env node
/**
 * `lint-no-stack-leak` CLI — guards the framework/ecosystem boundary.
 *
 * The shipped surface (agent prompts, the gan skill, the config-server source)
 * must stay ecosystem-neutral: ecosystem-specific vocabulary belongs inside
 * the stack files that own it, never in the generic framework. This script
 * walks a fixed scan scope (`agents/*.md`, `skills/gan/SKILL.md`, and the
 * `.ts` files under `src/config-server/`, recursively) and reports any line
 * containing a forbidden token (from `forbidden.json`) unless allowlisted.
 *
 * Two allowlist tiers exist. A permanent `paths` entry exempts a file with a
 * written justification. A `transitional` entry is a temporary exemption that
 * must *still* leak — the script emits {@link EMPTY_TRANSITIONAL_CODE} when a
 * transitional file no longer contains any token (or is gone), forcing the
 * dead exemption to be removed so it cannot outlive the file it protected.
 *
 * Output/exit follow the shared `scripts/lib` contract (`0`/`1`/`64`); the
 * leak report counts total hits, not distinct files. `run` is exported and
 * read-only; `main` owns argv and process I/O.
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

// Stable issue codes. A line carrying a forbidden token outside the allowlist
// is a LeakDetected; a transitional exemption that has gone quiet (the file no
// longer leaks, or is missing) is an EmptyTransitionalEntry. Named so tests/CI
// match on the constant rather than the literal string.
const LEAK_DETECTED_CODE = 'LeakDetected';
const EMPTY_TRANSITIONAL_CODE = 'EmptyTransitionalEntry';

// Repo root derived from this compiled module's location (dist/scripts/...),
// so the default forbidden/allowlist paths resolve regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

// `forbidden.json` is the single source of truth for forbidden tokens — shared
// with lint-error-text — and `allowlist.json` holds this script's exemptions.
const defaultForbiddenFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'forbidden.json');
const defaultAllowlistFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'allowlist.json');

/**
 * Shape of `forbidden.json`. The `web-node` key holds the list of forbidden
 * ecosystem tokens; a `string[]` is the only field this script reads.
 */
interface ForbiddenFile {
  'web-node': string[];
}

/**
 * Shape of `allowlist.json`.
 *
 * @property paths permanent exemptions, keyed by scan-root-relative path; the
 *   value is the free-text justification (read by humans, not by this script).
 * @property transitional temporary exemptions, same key/value shape, but each
 *   must still leak or it is flagged for removal (see module doc).
 */
interface AllowlistFile {
  paths: Record<string, string>;
  transitional: Record<string, string>;
}

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: lint-no-stack-leak [--scan-root <path>] [--allowlist-file <path>]',
    '                          [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Walks a fixed scan scope under <scan-root> and reports any file that',
    'contains a forbidden ecosystem token outside the allowlist.',
    '',
    'Scan scope:',
    '  - <scan-root>/agents/*.md',
    '  - <scan-root>/skills/gan/SKILL.md',
    '  - <scan-root>/src/config-server/**/*.ts (recursive)',
    '',
    'Options:',
    '  --scan-root <path>       Inspect this scan root instead of the repo root.',
    '  --allowlist-file <path>  Override the path to allowlist.json (testing only).',
    '  --project-root <path>    Accepted for arg-parser compatibility; unused.',
    '  --json                   Emit the report as a JSON document on stdout.',
    '  --quiet                  Suppress the stdout summary on a clean run.',
    '  --help                   Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No leaks detected.',
    '  1  At least one forbidden token leaked outside the allowlist,',
    '     or a transitional allowlist entry no longer contains any token.',
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
 * @property scanRoot root the fixed scan scope is taken relative to.
 * @property allowlistFile path to the allowlist JSON (overridable for tests).
 * @property forbiddenFile path to the forbidden-tokens JSON (overridable).
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  scanRoot: string;

  allowlistFile: string;

  forbiddenFile: string;

  json: boolean;

  quiet: boolean;
}

// Directories never descended into when walking TS sources: build output and
// dependencies are not part of the authored surface this lint governs.
const SKIP_DIRS = new Set('node_modules dist build'.split(' '));

/**
 * Recursively collect every `.ts` file under `dir`, skipping {@link SKIP_DIRS}.
 *
 * Returns `[]` when `dir` is absent or not a directory, and silently skips any
 * entry that cannot be `stat`ed, so a partially-readable tree never aborts the
 * scan. Order is filesystem order here; the callers sort. Reads disk only.
 */
function walkTsFiles(dir: string): string[] {
  let entries: string[];
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const abs = path.join(dir, e);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      files.push(...walkTsFiles(abs));
    } else if (st.isFile() && abs.endsWith('.ts')) {
      files.push(abs);
    }
  }
  return files;
}

/**
 * Build the ordered list of files in the fixed scan scope: every `agents/*.md`,
 * the gan `SKILL.md`, and every `.ts` under `src/config-server/`.
 *
 * Each segment is sorted independently and appended in a fixed order so the
 * file list (and thus the report) is deterministic. Missing pieces of the
 * scope (no `agents/`, no skill file) are skipped rather than erroring — the
 * scope is a superset and a repo need not contain every part. Reads disk only.
 */
function listScanFiles(scanRoot: string): string[] {
  const files: string[] = [];

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
          // Skip unreadable.
        }
      }
    }
  } catch {
    // Missing agents/ → skip.
  }

  const skillFile = path.join(scanRoot, 'skills', 'gan', 'SKILL.md');
  try {
    if (statSync(skillFile).isFile()) files.push(skillFile);
  } catch {
    // Missing skill file → skip.
  }

  const configDir = path.join(scanRoot, 'src', 'config-server');
  const tsFiles = walkTsFiles(configDir);
  tsFiles.sort();
  files.push(...tsFiles);

  return files;
}

/**
 * Read and `JSON.parse` a file, returning `null` (never throwing) on any read
 * or parse error. The generic `T` is an unchecked cast — callers validate the
 * shape afterward, treating `null` and a wrong shape alike as "unreadable".
 */
function readJsonFile<T>(absPath: string): T | null {
  try {
    const text = readFileSync(absPath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A single forbidden-token match: the `token` found and its 1-based `line`. */
interface MatchHit {
  token: string;
  line: number;
}

/**
 * Find every forbidden-token occurrence in `text`, scanning line by line so
 * each hit carries a 1-based line number for the report. A token appearing on
 * several lines yields several hits; several tokens on one line yield several
 * too. Substring match (`includes`), not word-boundary, so a token embedded in
 * a larger identifier still counts. Pure.
 */
function findHits(text: string, tokens: readonly string[]): MatchHit[] {
  const hits: MatchHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const token of tokens) {
      if (line.includes(token)) {
        hits.push({ token, line: i + 1 });
      }
    }
  }
  return hits;
}

/**
 * Express `abs` as a forward-slashed path relative to `scanRoot`, for matching
 * against the allowlist keys (which are stored in that form). Falls back to the
 * absolute path when `abs` is outside `scanRoot` (a `..`-prefixed or absolute
 * relative result), so an out-of-tree file can never accidentally match an
 * allowlist key. Pure.
 */
function relativeToScanRoot(scanRoot: string, abs: string): string {
  const rel = path.relative(scanRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

/**
 * Scan the fixed scope for forbidden-token leaks and check transitional
 * exemptions, returning a rendered {@link RunResult}.
 *
 * First the inputs are loaded: an unreadable/malformed `forbidden.json` →
 * `ForbiddenFileUnreadable`, an unreadable/malformed `allowlist.json` →
 * `AllowlistFileUnreadable`; either short-circuits with `checked: 0`. Then each
 * scan file not in `paths` or `transitional` is scanned, emitting a
 * {@link LEAK_DETECTED_CODE} failure per hit. Finally every `transitional`
 * entry is re-checked: if it no longer leaks (or the file is gone) it yields an
 * {@link EMPTY_TRANSITIONAL_CODE} failure so the stale exemption is removed.
 *
 * Exit code is `SUCCESS` with no failures, else `FAILURE`. Read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];

  const forbidden = readJsonFile<ForbiddenFile>(opts.forbiddenFile);
  if (forbidden === null || !Array.isArray(forbidden['web-node'])) {
    failures.push({
      path: opts.forbiddenFile,
      code: 'ForbiddenFileUnreadable',
      message:
        `forbidden-tokens file at ${opts.forbiddenFile} could not be read or is malformed. ` +
        `Restore the file from version control before re-running.`,
    });
    const report: LintNoStackLeakReport = {
      kind: 'lint-no-stack-leak',
      checked: 0,
      failures,
    };
    return finalize(report, opts);
  }

  const allowlist = readJsonFile<AllowlistFile>(opts.allowlistFile);
  if (
    allowlist === null ||
    typeof allowlist.paths !== 'object' ||
    allowlist.paths === null ||
    typeof allowlist.transitional !== 'object' ||
    allowlist.transitional === null
  ) {
    failures.push({
      path: opts.allowlistFile,
      code: 'AllowlistFileUnreadable',
      message:
        `allowlist file at ${opts.allowlistFile} could not be read or is malformed. ` +
        `Restore the file from version control before re-running.`,
    });
    const report: LintNoStackLeakReport = {
      kind: 'lint-no-stack-leak',
      checked: 0,
      failures,
    };
    return finalize(report, opts);
  }

  const tokens = forbidden['web-node'];
  const allowedPaths = allowlist.paths;
  const transitionalPaths = allowlist.transitional;

  const files = listScanFiles(opts.scanRoot);
  for (const abs of files) {
    const rel = relativeToScanRoot(opts.scanRoot, abs);
    // Both allowlist tiers exempt a file from the leak scan here; transitional
    // entries are not scanned for leaks but ARE separately re-checked below to
    // confirm they still leak (otherwise the exemption is dead).
    if (rel in allowedPaths || rel in transitionalPaths) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Listed but now unreadable: skip rather than fail — the file was
      // present at enumeration, so a transient read error is not a leak.
      continue;
    }
    const hits = findHits(text, tokens);
    for (const hit of hits) {
      failures.push({
        path: abs,
        code: LEAK_DETECTED_CODE,
        message:
          `forbidden token '${hit.token}' detected at ${abs}:${hit.line}. ` +
          `Ecosystem-specific tokens must live inside their owning stack file ` +
          `or in an allowlisted path with a written justification.`,
      });
    }
  }

  // Transitional sweep: a temporary exemption must keep earning its place. If
  // a transitional file no longer contains any forbidden token — or has been
  // deleted — the exemption is stale and must be removed, so flag it. This is
  // what stops the allowlist from accumulating exemptions for problems that no
  // longer exist (and silently exempting a file that re-leaks later).
  for (const rel of Object.keys(transitionalPaths)) {
    const abs = path.join(opts.scanRoot, rel);
    let text: string | null = null;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Missing/unreadable file counts as "no longer leaks" → flagged below.
      text = null;
    }
    const stillLeaks = text !== null && findHits(text, tokens).length > 0;
    if (!stillLeaks) {
      failures.push({
        path: abs,
        code: EMPTY_TRANSITIONAL_CODE,
        message:
          `transitional allowlist entry '${rel}' no longer contains any forbidden ` +
          `token (or the file is missing). Remove the entry from allowlist.json — ` +
          `transitional exemptions cannot outlive the file they protect.`,
      });
    }
  }

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
 * unexpected positional returns `BAD_ARGS` before scanning. The `scan-root`,
 * `allowlist-file`, and `forbidden-file` overrides are resolved to absolute
 * paths (testing seams); `--project-root` is accepted but ignored. Side effect:
 * writing stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help'],
    string: ['project-root', 'scan-root', 'allowlist-file', 'forbidden-file'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`lint-no-stack-leak --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`lint-no-stack-leak --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const scanRoot =
    typeof parsed.flags['scan-root'] === 'string'
      ? path.resolve(parsed.flags['scan-root'] as string)
      : repoRoot;

  const allowlistFile =
    typeof parsed.flags['allowlist-file'] === 'string'
      ? path.resolve(parsed.flags['allowlist-file'] as string)
      : defaultAllowlistFile;

  const forbiddenFile =
    typeof parsed.flags['forbidden-file'] === 'string'
      ? path.resolve(parsed.flags['forbidden-file'] as string)
      : defaultForbiddenFile;

  const result = run({
    scanRoot,
    allowlistFile,
    forbiddenFile,
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
    process.stderr.write(`lint-no-stack-leak: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

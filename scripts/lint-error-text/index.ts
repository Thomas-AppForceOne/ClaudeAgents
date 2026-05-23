#!/usr/bin/env node
/**
 * `lint-error-text` CLI — keeps user-facing strings ecosystem-neutral.
 *
 * A narrower sibling of `lint-no-stack-leak`: rather than flagging a forbidden
 * token anywhere in a file, it flags one only on an *emit site* — a line that
 * produces user-visible text (`message:`/`remediation:` literals,
 * `console.error(...)`, `userOutput(...)`). The rationale is that an ecosystem
 * token in an internal identifier or comment is harmless, but one in a string
 * the user reads breaks the framework's neutral voice. So this lint scans only
 * `src/config-server/` and `src/cli/`, only on emit-site lines.
 *
 * The forbidden tokens are the *same* list as the leak linter
 * (`lint-no-stack-leak/forbidden.json`) — one source of truth — but the
 * allowlist is this script's own. Output/exit follow the shared `scripts/lib`
 * contract (`0`/`1`/`64`); the report counts total hits. `run` is exported and
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
  type LintErrorTextReport,
  type ReportFailure,
} from '../lib/index.js';

// Stable issue code for a forbidden token found on a user-facing emit site.
const ERROR_TEXT_LEAK_CODE = 'ErrorTextLeakDetected';

// Repo root derived from this compiled module's location, so default paths
// resolve independent of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

// This script's own allowlist...
const defaultAllowlistFile = path.join(repoRoot, 'scripts', 'lint-error-text', 'allowlist.json');

// ...but the forbidden tokens are deliberately shared with lint-no-stack-leak,
// so the two linters can never disagree on what counts as ecosystem vocabulary.
const defaultForbiddenFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'forbidden.json');

/**
 * Shape of the shared `forbidden.json`. Only `web-node` (the token list) is
 * read here.
 */
interface ForbiddenFile {
  'web-node': string[];
}

/**
 * Shape of this script's `allowlist.json`.
 *
 * @property paths exempted files keyed by scan-root-relative path; the value
 *   is the human-readable justification (not interpreted by this script).
 */
interface AllowlistFile {
  paths: Record<string, string>;
}

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: lint-error-text [--scan-root <path>] [--allowlist-file <path>]',
    '                       [--forbidden-file <path>] [--project-root <path>]',
    '                       [--json] [--quiet] [--help]',
    '',
    'Walks src/config-server/ and src/cli/ under <scan-root> and reports any',
    'emit-site line (message:/remediation:/console.error/userOutput) that',
    'contains a forbidden ecosystem token. Forbidden tokens come from',
    'lint-no-stack-leak/forbidden.json (single source of truth).',
    '',
    'Options:',
    '  --scan-root <path>       Inspect this scan root instead of the repo root.',
    '  --allowlist-file <path>  Override the path to allowlist.json (testing only).',
    '  --forbidden-file <path>  Override the forbidden-tokens file (testing only).',
    '  --project-root <path>    Accepted for arg-parser compatibility; unused.',
    '  --json                   Emit the report as a JSON document on stdout.',
    '  --quiet                  Suppress the stdout summary on a clean run.',
    '  --help                   Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No emit-site leaks detected.',
    '  1  At least one emit-site line contained a forbidden token.',
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
 * @property scanRoot root the `src/config-server`/`src/cli` scan is relative to.
 * @property allowlistFile path to this script's allowlist JSON (test override).
 * @property forbiddenFile path to the shared forbidden-tokens JSON (override).
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

// Directories never descended into: build output and dependencies are not the
// authored source this lint governs.
const SKIP_DIRS = new Set('node_modules dist build'.split(' '));

// A line is an "emit site" if it matches any of these — i.e. it begins a
// user-visible string: a `message:`/`remediation:` field literal, a
// `console.error(...'...')` call, or a `userOutput(...'...')` call. The
// trailing quote requirement (`['"`]`) means only lines that actually open a
// string literal qualify, so a bare `message:` with no string is not a site.
// Restricting the token scan to these lines is what makes this lint narrower
// than the whole-file leak scanner.
const EMIT_SITE_PATTERNS: readonly RegExp[] = [
  /(?:message|remediation)\s*:\s*['"`]/,
  /console\.error\s*\(.*['"`]/,
  /userOutput\s*\(.*['"`]/,
];

/**
 * Recursively collect every `.ts` file under `dir`, skipping {@link SKIP_DIRS}.
 * Returns `[]` when `dir` is absent/not a directory; silently skips entries
 * that cannot be `stat`ed. Reads disk only. (Same walk as the leak linter.)
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
 * Build the scan set: every `.ts` under `src/config-server/` and `src/cli/`
 * (the two trees that produce user-facing output), sorted for deterministic
 * report order. Read-only.
 */
function listScanFiles(scanRoot: string): string[] {
  const files: string[] = [];
  files.push(...walkTsFiles(path.join(scanRoot, 'src', 'config-server')));
  files.push(...walkTsFiles(path.join(scanRoot, 'src', 'cli')));
  files.sort();
  return files;
}

/**
 * Read and `JSON.parse` a file, returning `null` (never throwing) on any read
 * or parse error. The `T` cast is unchecked; callers validate shape and treat
 * `null`/wrong-shape alike as "unreadable".
 */
function readJsonFile<T>(absPath: string): T | null {
  try {
    const text = readFileSync(absPath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Is `line` a user-facing emit site? True iff it matches any
 * {@link EMIT_SITE_PATTERNS} regex. This is the line-level filter that scopes
 * the token scan to strings the user actually sees. Pure.
 */
function isEmitSite(line: string): boolean {
  for (const re of EMIT_SITE_PATTERNS) {
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * Find forbidden-token hits on emit-site lines only.
 *
 * Walks `text` line by line, ignores non-emit-site lines via {@link isEmitSite},
 * and on each remaining line records one hit per matching token (1-based line
 * number for the report). Substring match, so a token inside a larger word
 * counts. Pure. This is the key difference from the leak linter, which scans
 * every line.
 */
function findEmitSiteHits(
  text: string,
  tokens: readonly string[],
): { token: string; line: number }[] {
  const hits: { token: string; line: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!isEmitSite(line)) continue;
    for (const token of tokens) {
      if (line.includes(token)) {
        hits.push({ token, line: i + 1 });
      }
    }
  }
  return hits;
}

/**
 * Express `abs` as a forward-slashed path relative to `scanRoot` for allowlist
 * key matching; falls back to the absolute path when `abs` is outside
 * `scanRoot`, so an out-of-tree file cannot accidentally match a key. Pure.
 */
function relativeToScanRoot(scanRoot: string, abs: string): string {
  const rel = path.relative(scanRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

/**
 * Scan emit sites across `src/config-server` and `src/cli` for forbidden
 * tokens, returning a rendered {@link RunResult}.
 *
 * Loads inputs first: an unreadable/malformed `forbidden.json` →
 * `ForbiddenFileUnreadable`, an unreadable/malformed `allowlist.json` →
 * `AllowlistFileUnreadable`; either short-circuits with `checked: 0`. Then each
 * non-allowlisted scan file is inspected via {@link findEmitSiteHits}, emitting
 * an {@link ERROR_TEXT_LEAK_CODE} failure per hit (an unreadable file is
 * skipped, not failed). Exit code is `SUCCESS` with no failures, else
 * `FAILURE`. Read-only.
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
    const report: LintErrorTextReport = {
      kind: 'lint-error-text',
      checked: 0,
      failures,
    };
    return finalize(report, opts);
  }

  const allowlist = readJsonFile<AllowlistFile>(opts.allowlistFile);
  if (allowlist === null || typeof allowlist.paths !== 'object' || allowlist.paths === null) {
    failures.push({
      path: opts.allowlistFile,
      code: 'AllowlistFileUnreadable',
      message:
        `allowlist file at ${opts.allowlistFile} could not be read or is malformed. ` +
        `Restore the file from version control before re-running.`,
    });
    const report: LintErrorTextReport = {
      kind: 'lint-error-text',
      checked: 0,
      failures,
    };
    return finalize(report, opts);
  }

  const tokens = forbidden['web-node'];
  const allowedPaths = allowlist.paths;

  const files = listScanFiles(opts.scanRoot);
  for (const abs of files) {
    const rel = relativeToScanRoot(opts.scanRoot, abs);
    // Allowlisted file: skip entirely (there is no transitional tier here,
    // unlike lint-no-stack-leak).
    if (rel in allowedPaths) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Listed but now unreadable: skip rather than fail.
      continue;
    }
    const hits = findEmitSiteHits(text, tokens);
    for (const hit of hits) {
      failures.push({
        path: abs,
        code: ERROR_TEXT_LEAK_CODE,
        message:
          `forbidden token '${hit.token}' detected at ${abs}:${hit.line} on a user-facing ` +
          `emit site. User-visible strings must use shell remediation and refer to ` +
          `"the framework" rather than ecosystem-specific vocabulary.`,
      });
    }
  }

  const report: LintErrorTextReport = {
    kind: 'lint-error-text',
    checked: files.length,
    failures,
  };
  return finalize(report, opts);
}

/**
 * Turn a finished report into a {@link RunResult}: render it (JSON vs. human),
 * suppress the clean-run stdout summary under `--quiet`, and derive the exit
 * code (`SUCCESS` iff no failures, else `FAILURE`). Pure.
 */
function finalize(report: LintErrorTextReport, opts: RunOptions): RunResult {
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
 * unexpected positional returns `BAD_ARGS` before scanning. The
 * `scan-root`/`allowlist-file`/`forbidden-file` overrides are resolved to
 * absolute paths (test seams); `--project-root` is accepted but ignored. Side
 * effect: writing stdout/stderr.
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
      `Error: unknown argument '${offender}'. Run \`lint-error-text --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`lint-error-text --help\` for usage.\n`,
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
    process.stderr.write(`lint-error-text: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

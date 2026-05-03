#!/usr/bin/env node
/**
 * R4 sprint 5 — `lint-error-text` maintainer script.
 *
 * CI backstop for the user-facing-error-text discipline (per F4 / the
 * project context's "Honor the user-facing error-text discipline" Do):
 * every user-visible string emitted by the agent, CLI, prompts, or
 * error paths must use shell remediation (`rm <path>`) not Node
 * remediation (`npm run …`), and must refer to "the framework" rather
 * than "the npm package". This script walks the canonical user-facing
 * surface (`src/config-server/**\/*.ts`, `src/cli/**\/*.ts`) and fails
 * when an emit-site line contains a forbidden ecosystem token.
 *
 * Forbidden tokens are read from `lint-no-stack-leak/forbidden.json` —
 * single source of truth (per anti-criterion AN8). This script does NOT
 * inline the token list.
 *
 * Emit-site heuristic. The script flags a line only when it both
 * matches an emit-site shape AND contains a forbidden token:
 *
 *   - `(message|remediation):\s*['"\`]`  — F2 structured-error fields.
 *   - `console\.error\s*\(.*['"\`]`     — direct stderr writes with a
 *                                         literal string.
 *   - `userOutput\s*\(.*['"\`]`         — userOutput-style helpers.
 *
 * Lines that mention a token outside an emit site (variable names,
 * comments, regex patterns, schema fields) do not fire. The discipline
 * applies to user-facing strings, not to the codebase's vocabulary.
 *
 * Allowlist (`./allowlist.json`, `paths` block only) exempts whole
 * files. New entries must carry a written justification (per the
 * allowlist-discipline rule).
 *
 * Per anti-criterion AN3, this script does not throw. Failures surface
 * as `ErrorTextLeakDetected` report entries.
 *
 * Exit codes (per `SCRIPT_EXIT`):
 *   - 0 on a clean run (no failures);
 *   - 1 when one or more emit-site lines contain a forbidden token;
 *   - 64 when the caller passed an unknown flag.
 *
 * Output:
 *   - default: one-line summary on stdout, one line per failure on
 *     stderr (path + code + message).
 *   - `--json`: a sorted-key two-space-indent JSON document on stdout
 *     with the failure list embedded.
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

const ERROR_TEXT_LEAK_CODE = 'ErrorTextLeakDetected';

const here = path.dirname(fileURLToPath(import.meta.url));
// Script lives at `dist/scripts/lint-error-text/index.js`. Three `..`
// segments reach the repo root (mirrors the other R4 scripts).
const repoRoot = path.resolve(here, '..', '..', '..');
// `allowlist.json` ships as source-tree data under
// `<repo>/scripts/lint-error-text/` (tsc does not copy non-TS files to
// dist). The script reads it at runtime from the source location.
const defaultAllowlistFile = path.join(repoRoot, 'scripts', 'lint-error-text', 'allowlist.json');
// Single source of truth for forbidden tokens lives next to
// `lint-no-stack-leak`. Per anti-criterion AN8, this script does not
// inline the list.
const defaultForbiddenFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'forbidden.json');

interface ForbiddenFile {
  'web-node': string[];
}

interface AllowlistFile {
  paths: Record<string, string>;
}

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

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {
  /** Pre-canonicalised scan root. */
  scanRoot: string;
  /** Absolute path to the allowlist JSON file. */
  allowlistFile: string;
  /** Absolute path to the forbidden-tokens JSON file. */
  forbiddenFile: string;
  /** Emit the report as JSON instead of summary + per-failure stderr. */
  json: boolean;
  /** Suppress the success-path stdout summary. */
  quiet: boolean;
}

const SKIP_DIRS = new Set('node_modules dist build'.split(' '));

const EMIT_SITE_PATTERNS: readonly RegExp[] = [
  /(?:message|remediation)\s*:\s*['"`]/,
  /console\.error\s*\(.*['"`]/,
  /userOutput\s*\(.*['"`]/,
];

/**
 * Recursively walk a directory and return absolute paths to every
 * `.ts` file, skipping standard build-artefact directories. Returns an
 * empty list if the directory does not exist.
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
 * Build the scan list: every `.ts` file under `<scanRoot>/src/config-server/`
 * and `<scanRoot>/src/cli/`, sorted lexicographically.
 */
function listScanFiles(scanRoot: string): string[] {
  const files: string[] = [];
  files.push(...walkTsFiles(path.join(scanRoot, 'src', 'config-server')));
  files.push(...walkTsFiles(path.join(scanRoot, 'src', 'cli')));
  files.sort();
  return files;
}

function readJsonFile<T>(absPath: string): T | null {
  try {
    const text = readFileSync(absPath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isEmitSite(line: string): boolean {
  for (const re of EMIT_SITE_PATTERNS) {
    if (re.test(line)) return true;
  }
  return false;
}

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

function relativeToScanRoot(scanRoot: string, abs: string): string {
  const rel = path.relative(scanRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

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
    if (rel in allowedPaths) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
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
 * Bin entry. Tests invoke the compiled output via
 * `child_process.spawn`, so this code path runs whenever the file is
 * the script's bin target.
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

#!/usr/bin/env node
/**
 * R4 sprint 5 — `lint-no-stack-leak` maintainer script.
 *
 * Permanent backstop for the multi-stack guard rail (per
 * PROJECT_CONTEXT.md): ecosystem-specific tokens (`npm`, `node_modules`,
 * `package.json`, …) must live inside their owning stack file or an
 * allowlisted framework path. This script walks a fixed scan scope and
 * fails when a forbidden token appears in a non-allowlisted file.
 *
 * Scan scope (hard-coded; see `listScanFiles`):
 *   - `<scan-root>/agents/*.md`
 *   - `<scan-root>/skills/gan/SKILL.md`
 *   - `<scan-root>/src/config-server/**\/*.ts` (recursive, skipping
 *     `node_modules`, `dist`, `build`).
 *
 * Forbidden tokens come from `./forbidden.json` (the `web-node` array).
 * `lint-error-text` reads the same file as the single source of truth.
 *
 * Allowlist (`./allowlist.json`) has two blocks:
 *   - `paths` — permanent exemptions; framework infrastructure that
 *     legitimately references its own ecosystem (`reads.ts` reading its
 *     package.json, `detection.ts` skipping `node_modules`, etc.). Every
 *     entry carries a justification string.
 *   - `transitional` — files slated for retirement (e.g. legacy agent
 *     prompts retired by E1). Each entry is an internal-consistency
 *     check: the script reads the file and verifies it still contains
 *     at least one forbidden token. An empty transitional entry fails
 *     until the entry is removed (so the allowlist cannot rot).
 *
 * Per anti-criterion AN3, this script does not throw. Failures surface
 * as `LeakDetected` / `EmptyTransitionalEntry` report entries.
 *
 * Exit codes (per `SCRIPT_EXIT`):
 *   - 0 on a clean run (no failures);
 *   - 1 when one or more files leak a forbidden token outside the
 *     allowlist, OR when a transitional entry is empty/missing;
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
  type LintNoStackLeakReport,
  type ReportFailure,
} from '../lib/index.js';

const LEAK_DETECTED_CODE = 'LeakDetected';
const EMPTY_TRANSITIONAL_CODE = 'EmptyTransitionalEntry';

const here = path.dirname(fileURLToPath(import.meta.url));
// Script lives at `dist/scripts/lint-no-stack-leak/index.js`. Three `..`
// segments reach the repo root (mirrors the other R4 scripts).
const repoRoot = path.resolve(here, '..', '..', '..');
// `forbidden.json` and `allowlist.json` ship as source-tree data under
// `<repo>/scripts/lint-no-stack-leak/` (tsc does not copy non-TS files
// to dist). The script reads them at runtime from the source location;
// tests can override either via `--forbidden-file` / `--allowlist-file`.
const defaultForbiddenFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'forbidden.json');
const defaultAllowlistFile = path.join(repoRoot, 'scripts', 'lint-no-stack-leak', 'allowlist.json');

interface ForbiddenFile {
  'web-node': string[];
}

interface AllowlistFile {
  paths: Record<string, string>;
  transitional: Record<string, string>;
}

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
 * Build the full scan list:
 *   - every `*.md` file directly under `<scanRoot>/agents/`;
 *   - `<scanRoot>/skills/gan/SKILL.md` if present;
 *   - every `.ts` file under `<scanRoot>/src/config-server/` recursively.
 *
 * Returns an empty list for any missing directory; each subtree is
 * sorted for deterministic enumeration.
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

function readJsonFile<T>(absPath: string): T | null {
  try {
    const text = readFileSync(absPath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface MatchHit {
  token: string;
  line: number;
}

/**
 * Find every forbidden-token hit in a file's text. Returns one entry per
 * match (multiple tokens on the same line yield multiple hits).
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
 * Translate `<scan-root>/some/path` to its scan-root-relative form
 * (`some/path`, POSIX separators). Returns the absolute path unchanged
 * if it does not live under `scanRoot`.
 */
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
    if (rel in allowedPaths || rel in transitionalPaths) {
      // Allowlisted: skip leak detection (transitional entries get the
      // internal-consistency check below).
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Unreadable file: skip silently rather than fabricating a leak.
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

  // Internal-consistency check: every transitional entry must still
  // contain at least one forbidden token. If the file is missing or no
  // longer references any token, the entry has rotted and must be
  // removed.
  for (const rel of Object.keys(transitionalPaths)) {
    const abs = path.join(opts.scanRoot, rel);
    let text: string | null = null;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
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

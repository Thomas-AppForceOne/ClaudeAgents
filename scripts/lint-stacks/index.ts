#!/usr/bin/env node
/**
 * R4 sprint 1 — `lint-stacks` maintainer script.
 *
 * Walks `<projectRoot>/stacks/*.md` and applies two checks per file:
 *
 *   1. ScaffoldBannerPresent — the first non-blank prose line after the
 *      YAML block must NOT match the canonical DRAFT banner string.
 *      (The banner is a deliberate `gan stacks new` artefact; leaving
 *      it in is the framework's signal that the file is a half-finished
 *      scaffold.) The check imports the same `DRAFT_BANNER` constant
 *      that `gan stacks new` writes, so the two stay in lockstep.
 *
 *   2. SchemaMismatch — the YAML body parses against `stack-v1.json`
 *      (delegated to `validateStackBodyAgainstSchema`). All ajv errors
 *      are collected; the script does not short-circuit on the first
 *      violation.
 *
 * Per the single-implementation rule, both checks delegate to existing
 * code: the YAML parser, the schema validator, and the banner constant
 * are imported from `src/config-server/`. The script itself owns no
 * parsing or validation logic.
 *
 * Exit codes (per `SCRIPT_EXIT`):
 *   - 0 on a clean run (no failures);
 *   - 1 when one or more files fail either check;
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

import { parseYamlBlock } from '../../src/config-server/storage/yaml-block-parser.js';
import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';
import { DRAFT_BANNER } from '../../src/config-server/scaffold-banner.js';
import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  type ReportFailure,
} from '../lib/index.js';

const SCAFFOLD_BANNER_CODE = 'ScaffoldBannerPresent';

function renderHelp(): string {
  return [
    'Usage: lint-stacks [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Walks <project-root>/stacks/*.md and reports any file that:',
    '  - still carries the scaffold DRAFT banner as its first prose line',
    '    (issue code: ScaffoldBannerPresent), or',
    '  - fails the published stack-v1 schema',
    '    (issue code: SchemaMismatch).',
    '',
    'Options:',
    '  --project-root <path>  Inspect this project root instead of the cwd.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  All files passed.',
    '  1  At least one file failed a check.',
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
  /** Pre-canonicalised project root. */
  projectRoot: string;
  /** Emit the report as JSON instead of summary + per-failure stderr. */
  json: boolean;
  /** Suppress the success-path stdout summary. */
  quiet: boolean;
}

function listStackFiles(projectRoot: string): string[] {
  const stacksDir = path.join(projectRoot, 'stacks');
  let entries: string[];
  try {
    const stat = statSync(stacksDir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(stacksDir);
  } catch {
    // Missing `stacks/` directory is a clean state, not an error: a
    // brand-new project root with zero stack files is "0 checked, 0
    // failed".
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (!e.endsWith('.md')) continue;
    const abs = path.join(stacksDir, e);
    try {
      if (statSync(abs).isFile()) {
        files.push(abs);
      }
    } catch {
      // Unreadable entry: skip silently. The runtime path enforces the
      // same behaviour.
    }
  }
  // Sort lexicographically so per-fixture test output is deterministic
  // without depending on filesystem enumeration order.
  files.sort();
  return files;
}

function firstNonBlankLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return line.trimEnd();
  }
  return null;
}

function checkFile(absPath: string): ReportFailure[] {
  const failures: ReportFailure[] = [];
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push({
      path: absPath,
      code: 'MissingFile',
      message: `Stack file '${absPath}' could not be read: ${msg}.`,
    });
    return failures;
  }

  let parsed: ReturnType<typeof parseYamlBlock> | null = null;
  try {
    parsed = parseYamlBlock(text, absPath);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    failures.push({
      path: absPath,
      code: typeof err.code === 'string' ? err.code : 'InvalidYAML',
      message: err.message ?? 'Failed to parse YAML block.',
    });
    return failures;
  }

  // Banner check: first non-blank line of the prose AFTER the YAML block.
  const banner = firstNonBlankLine(parsed.prose.after);
  if (banner === DRAFT_BANNER) {
    failures.push({
      path: absPath,
      code: SCAFFOLD_BANNER_CODE,
      message:
        `Stack file '${absPath}' still carries the scaffold DRAFT banner as its first ` +
        `prose line. The banner is the framework's signal that the file is a ` +
        `half-finished scaffold; replace the TODOs in the file and remove the banner ` +
        `before committing.`,
    });
  }

  // Schema check.
  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(absPath, parsed.data, issues);
  for (const issue of issues) {
    failures.push({
      path: issue.path ?? absPath,
      code: issue.code,
      message: issue.message,
    });
  }

  return failures;
}

export function run(opts: RunOptions): RunResult {
  const files = listStackFiles(opts.projectRoot);
  const failures: ReportFailure[] = [];
  for (const f of files) {
    failures.push(...checkFile(f));
  }
  const report = {
    kind: 'lint-stacks' as const,
    checked: files.length,
    failures,
  };

  if (opts.json) {
    return {
      stdout: formatReportJson(report),
      stderr: '',
      code: failures.length === 0 ? SCRIPT_EXIT.SUCCESS : SCRIPT_EXIT.FAILURE,
    };
  }

  const formatted = formatReport(report);
  const stdout = opts.quiet && failures.length === 0 ? '' : formatted.stdout;
  return {
    stdout,
    stderr: formatted.stderr,
    code: failures.length === 0 ? SCRIPT_EXIT.SUCCESS : SCRIPT_EXIT.FAILURE,
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
    string: ['project-root'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`lint-stacks --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`lint-stacks --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const result = run({
    projectRoot: parsed.projectRoot,
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
    process.stderr.write(`lint-stacks: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

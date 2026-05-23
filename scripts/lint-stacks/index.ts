#!/usr/bin/env node
/**
 * `lint-stacks` CLI — validates a project's stack `.md` files.
 *
 * Walks `<project-root>/stacks/*.md` and flags two failure classes per file:
 * an unreplaced scaffold DRAFT banner (a file committed while still a
 * half-finished template), and any violation of the published stack-v1 schema.
 * It reuses the same `parseYamlBlock` + `validateStackBodyAgainstSchema` path
 * the runtime uses, so a file that passes this lint is one the runtime accepts.
 *
 * Output and exit codes follow the shared `scripts/lib` contract: a
 * {@link RunResult} carrying stdout/stderr plus an exit code (`0` clean, `1`
 * at least one failure, `64` usage error). `run` is exported and pure w.r.t.
 * process state (it only reads files) so tests can drive it directly; `main`
 * owns argv parsing and process I/O.
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

// Issue code emitted when a stack file still shows the scaffold DRAFT banner.
// Defined as a named constant so the value is stated once and matched on by
// tests/CI rather than duplicating the literal at the emit site.
const SCAFFOLD_BANNER_CODE = 'ScaffoldBannerPresent';

/** Build the `--help` text. Pure; returns the usage block as a single string. */
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

/** What {@link run} returns: the text for each stream plus the process exit code. */
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Resolved options for {@link run}, produced by {@link main} from parsed argv.
 *
 * @property projectRoot canonical root whose `stacks/` directory is scanned.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run (failures still
 *   print to stderr).
 */
interface RunOptions {
  projectRoot: string;

  json: boolean;

  quiet: boolean;
}

/**
 * List the stack files to check: `<projectRoot>/stacks/*.md`, sorted for
 * deterministic output.
 *
 * Returns `[]` (not an error) when `stacks/` is absent or is not a directory —
 * a project with no stacks legitimately has nothing to lint. Individual
 * entries that cannot be `stat`ed are skipped silently, mirroring the
 * runtime's own tolerance of unreadable entries. Only reads the filesystem.
 */
function listStackFiles(projectRoot: string): string[] {
  const stacksDir = path.join(projectRoot, 'stacks');
  let entries: string[];
  try {
    const stat = statSync(stacksDir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(stacksDir);
  } catch {

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

  files.sort();
  return files;
}

/**
 * Return the first line of `text` that is not blank/whitespace-only, with
 * trailing whitespace trimmed, or `null` if every line is blank. Used to find
 * the file's first prose line for the banner comparison, so leading blank
 * lines before the banner do not hide it.
 */
function firstNonBlankLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return line.trimEnd();
  }
  return null;
}

/**
 * Check a single stack file and return its failures (empty array = clean).
 *
 * Runs three gates in order, each producing a {@link ReportFailure} keyed by a
 * stable `code`: the file is read (`MissingFile` if unreadable, and the file
 * is then skipped), its YAML block is parsed (the parser's own `code`, or
 * `InvalidYAML`, on failure — again short-circuiting), then the parsed body is
 * checked for the scaffold banner ({@link SCAFFOLD_BANNER_CODE}) and against
 * the stack schema (one failure per schema {@link Issue}). Never throws:
 * read/parse errors are caught and converted into failures. Only reads disk.
 *
 * @param absPath absolute path to the stack `.md` file.
 */
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

/**
 * Lint every stack file under `opts.projectRoot` and render the result.
 *
 * Aggregates each file's {@link checkFile} failures, then renders either JSON
 * (`opts.json`) or the human summary. The exit code in the returned
 * {@link RunResult} is `SUCCESS` when there are no failures, else `FAILURE` —
 * `BAD_ARGS` is never produced here (that is purely a `main`/argv concern).
 * Side-effect-free apart from reading the stack files.
 *
 * @param opts resolved {@link RunOptions}.
 */
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
 * CLI entrypoint: parse argv, dispatch to {@link run}, and write its output.
 *
 * Returns the exit code rather than calling `process.exit`, so it is testable
 * in-process. `--help` short-circuits with `SUCCESS` before any work; an
 * unknown flag or unexpected positional returns `BAD_ARGS` without running the
 * lint. Otherwise the {@link run} result's streams are written and its code
 * returned. The only side effects are writing to stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
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

// Module-level invocation: run as a script and translate the resolved exit
// code into the actual process exit. The rejection arm is the last-resort net
// for an *unexpected* throw (everything anticipated is already returned as a
// failure report); it prints a `fatal:` line and exits FAILURE so an
// uncaught error can never masquerade as success.
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

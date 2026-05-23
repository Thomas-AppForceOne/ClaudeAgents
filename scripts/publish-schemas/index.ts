#!/usr/bin/env node
/**
 * `publish-schemas` CLI — keeps the published JSON Schemas in canonical form.
 *
 * For each schema in the hard-coded {@link SCHEMA_FILES} set, it parses the
 * on-disk JSON, re-emits it through the same `stableStringify` the runtime
 * uses, and compares byte-for-byte. The two modes differ only in how drift is
 * handled: `--dry-run` reports it as a `SchemaDrift` failure (so CI fails),
 * while the default write mode repairs it in place via `atomicWriteFile` and
 * tallies the rewrite count. Canonical-on-disk schemas are the precondition
 * for the byte-level comparisons other checks rely on.
 *
 * The schema set is intentionally hard-coded — adding or removing one is a
 * coordinated change, not a glob — so a missing file is a `SchemaMissing`
 * failure rather than a silently smaller run. Output/exit follow the shared
 * `scripts/lib` contract (`0`/`1`/`64`); `run` is exported, `main` owns argv.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile } from '../../src/config-server/storage/atomic-write.js';
import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  stableStringify,
  type PublishSchemasReport,
  type ReportFailure,
} from '../lib/index.js';

// The published schema set, hard-coded on purpose: adding or removing a schema
// is a coordinated edit (the runtime, fixtures, and this list move together),
// so the script checks exactly these and treats any absent file as a failure
// rather than letting a glob quietly shrink the set.
const SCHEMA_FILES = ['api-tools-v1.json', 'overlay-v1.json', 'stack-v1.json'] as const;

// Locate the repo root relative to this compiled module so default paths work
// regardless of cwd. `here` is dist/scripts/publish-schemas, so three levels up
// is the repo root, and `<repo>/schemas` holds the published schema files.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');
const defaultSchemaRoot = path.join(repoRoot, 'schemas');

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: publish-schemas [--dry-run] [--schema-root <path>]',
    '                       [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Reads each published JSON Schema, re-emits it via the canonical',
    '`stableStringify` form, and compares to the on-disk bytes. In `--dry-run`',
    'mode, drift is reported as a SchemaDrift failure (exit 1). In the default',
    "(write) mode, drift is repaired in place via R1's `atomicWriteFile` helper.",
    '',
    'Schemas (hard-coded; coordinated edits required to add/remove):',
    '  - api-tools-v1.json',
    '  - overlay-v1.json',
    '  - stack-v1.json',
    '',
    'Options:',
    '  --dry-run              Report drift without rewriting any files.',
    '  --schema-root <path>   Override the directory holding the schemas',
    '                         (default: <repo>/schemas).',
    '  --project-root <path>  Accepted for arg-parser compatibility; unused.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  All schemas match canonical form (or drift was repaired).',
    '  1  At least one schema drifted (dry-run), is missing, or failed to parse.',
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
 * @property schemaRoot directory holding the schema files to check.
 * @property dryRun report drift as failures instead of rewriting files.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  schemaRoot: string;

  dryRun: boolean;

  json: boolean;

  quiet: boolean;
}

/**
 * Read a file as UTF-8, or return `null` if it does not exist / cannot be
 * read. Distinguishes "absent" (caller reports `SchemaMissing`) from a present
 * file, without throwing.
 */
function readFileIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Check (and, outside `--dry-run`, repair) every schema's canonical form.
 *
 * For each {@link SCHEMA_FILES} entry: a missing file → `SchemaMissing`
 * failure; invalid JSON → `SchemaParseError` failure; otherwise the parsed
 * value is re-serialised canonically and compared to the bytes on disk. When
 * they match, nothing happens. When they differ, `--dry-run` records a
 * `SchemaDrift` failure while write mode calls `atomicWriteFile` and increments
 * `rewritten`. `checked` is always the full schema count regardless of outcome.
 *
 * The exit code is `SUCCESS` when there are no failures (so a successful
 * write-mode repair exits `0`), else `FAILURE`. Side effect: in write mode,
 * rewrites drifted schema files on disk; otherwise read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];
  let rewritten = 0;

  for (const name of SCHEMA_FILES) {
    const abs = path.join(opts.schemaRoot, name);

    const onDisk = readFileIfExists(abs);
    if (onDisk === null) {
      failures.push({
        path: abs,
        code: 'SchemaMissing',
        message:
          `schema file not found at ${abs}. The published schema set is hard-coded; ` +
          `restore the file from version control before re-running.`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(onDisk) as unknown;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({
        path: abs,
        code: 'SchemaParseError',
        message: `Schema file '${abs}' is not valid JSON: ${msg}.`,
      });
      continue;
    }

    const canonical = stableStringify(parsed);

    // Byte-identical to canonical form: nothing to report or rewrite. The
    // comparison is on raw bytes (not parsed equality) because the whole point
    // is that the file's serialisation, not just its data, is canonical.
    if (onDisk === canonical) {
      continue;
    }

    if (opts.dryRun) {
      const truncated = canonical.slice(0, 200);
      failures.push({
        path: abs,
        code: 'SchemaDrift',
        message:
          `on-disk bytes differ from canonical stableStringify form; ` +
          `first 200 chars of canonical: ${truncated}`,
      });
      continue;
    }

    atomicWriteFile(abs, canonical);
    rewritten += 1;
  }

  const report: PublishSchemasReport = {
    kind: 'publish-schemas',
    checked: SCHEMA_FILES.length,
    failures,
    rewritten,
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
 * in-process. `--help` short-circuits with `SUCCESS`; an unknown flag or
 * unexpected positional returns `BAD_ARGS` before any schema is touched.
 * `--project-root` is accepted only for arg-parser uniformity and ignored.
 * Side effects: writing stdout/stderr, plus whatever {@link run} writes in
 * non-dry-run mode.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help', 'dry-run'],
    string: ['schema-root', 'project-root'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`publish-schemas --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`publish-schemas --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const schemaRoot =
    typeof parsed.flags['schema-root'] === 'string'
      ? (parsed.flags['schema-root'] as string)
      : defaultSchemaRoot;

  const result = run({
    schemaRoot,
    dryRun: parsed.flags['dry-run'] === true,
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
    process.stderr.write(`publish-schemas: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

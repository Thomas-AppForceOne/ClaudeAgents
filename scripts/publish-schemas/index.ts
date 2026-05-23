#!/usr/bin/env node

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

const SCHEMA_FILES = ['api-tools-v1.json', 'overlay-v1.json', 'stack-v1.json'] as const;

const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');
const defaultSchemaRoot = path.join(repoRoot, 'schemas');

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

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {

  schemaRoot: string;

  dryRun: boolean;

  json: boolean;

  quiet: boolean;
}

function readFileIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

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

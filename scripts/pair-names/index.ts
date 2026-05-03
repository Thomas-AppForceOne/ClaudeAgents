#!/usr/bin/env node
/**
 * R4 sprint 2 — `pair-names` maintainer script.
 *
 * CI-time backstop for the `pairsWith.consistency` cross-file invariant
 * (per F3 catalog; sourced from M1 + C5). Discovers every stack file
 * the runtime would enumerate (built-in + user + project tier), hydrates
 * each row's `data`/`prose` from disk, and runs the canonical
 * `checkPairsWithConsistency` invariant. Each issue surfaces as a
 * report failure with its F2 code, message, and field path.
 *
 * Per the single-implementation rule (PROJECT_CONTEXT.md, R1-locked),
 * the YAML parser, the snapshot builder, and the invariant check are
 * imported from `src/config-server/`; this script owns no parsing or
 * pairing logic. The C5 verbatim remediation hint is built inside the
 * imported invariant and reproduced byte-for-byte.
 *
 * Exit codes (per `SCRIPT_EXIT`):
 *   - 0 on a clean run (no failures);
 *   - 1 when the invariant fires for at least one stack file;
 *   - 64 when the caller passed an unknown flag.
 *
 * Output:
 *   - default: one-line summary on stdout, one line per failure on
 *     stderr (path + code + message).
 *   - `--json`: a sorted-key two-space-indent JSON document on stdout
 *     with the failure list embedded.
 */

import { readFileSync } from 'node:fs';

import { _runPhase1ForTests } from '../../src/config-server/tools/validate.js';
import { parseYamlBlock } from '../../src/config-server/storage/yaml-block-parser.js';
import { checkPairsWithConsistency } from '../../src/config-server/invariants/pairs-with-consistency.js';
import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  type PairNamesReport,
  type ReportFailure,
} from '../lib/index.js';

function renderHelp(): string {
  return [
    'Usage: pair-names [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Runs the `pairsWith.consistency` invariant against every stack file the',
    'runtime would enumerate at <project-root> (built-in + user + project',
    'tiers). Reports any project-tier file that shadows a paired built-in',
    'without re-declaring `pairsWith` (issue code: InvariantViolation).',
    '',
    'Options:',
    '  --project-root <path>  Inspect this project root instead of the cwd.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No invariant violations.',
    '  1  At least one stack file failed the pairs-with consistency check.',
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

/**
 * Hydrate every stack row's `data`/`prose` from disk. Phase 1 only
 * records paths and tier provenance; the invariant needs the parsed
 * YAML body to read `pairsWith`. Mirrors the hydration pattern used in
 * `tests/config-server/invariants/pairs-with-consistency.test.ts`.
 */
function hydrateSnapshot(snapshot: ReturnType<typeof _runPhase1ForTests>): void {
  for (const row of snapshot.stackFiles.values()) {
    let text: string;
    try {
      text = readFileSync(row.path, 'utf8');
    } catch {
      // Unreadable row: leave `data`/`prose` unset. The invariant treats
      // missing data as a no-op rather than fabricating a violation.
      continue;
    }
    try {
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // YAML parse failure: leave `data`/`prose` unset. Schema-level
      // parse errors are reported by `lint-stacks` (sprint 1), not here.
      continue;
    }
  }
}

export function run(opts: RunOptions): RunResult {
  const snapshot = _runPhase1ForTests(opts.projectRoot);
  hydrateSnapshot(snapshot);

  const issues = checkPairsWithConsistency(snapshot);
  const failures: ReportFailure[] = issues.map((issue) => {
    const failure: ReportFailure = {
      path: issue.path ?? opts.projectRoot,
      code: issue.code,
      message: issue.message,
    };
    if (typeof issue.field === 'string') {
      failure.field = issue.field;
    }
    return failure;
  });

  const report: PairNamesReport = {
    kind: 'pair-names',
    checked: snapshot.stackFiles.size,
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
      `Error: unknown argument '${offender}'. Run \`pair-names --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`pair-names --help\` for usage.\n`,
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
    process.stderr.write(`pair-names: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

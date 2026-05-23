#!/usr/bin/env node
/**
 * `pair-names` CLI — enforces the `pairsWith.consistency` stack invariant.
 *
 * A project-tier stack file may shadow a built-in of the same name; when the
 * built-in declares a `pairsWith` relationship, the shadowing file must
 * re-declare it or the pairing is silently lost. This script enumerates every
 * stack file the runtime would see at `<project-root>` (built-in + user +
 * project tiers), then runs {@link checkPairsWithConsistency} over that
 * snapshot and reports each `InvariantViolation`.
 *
 * It reuses the runtime's own phase-1 enumeration (`_runPhase1ForTests`) so
 * the file set is exactly what resolution would see; the snapshot is then
 * hydrated with parsed YAML before the check. Output/exit follow the shared
 * `scripts/lib` contract (`0`/`1`/`64`); `run` is exported and pure w.r.t.
 * process state, `main` owns argv and process I/O.
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

/** Build the `--help` text. Pure; returns the usage block as a single string. */
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

/** What {@link run} returns: the text for each stream plus the process exit code. */
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Resolved options for {@link run}, produced by {@link main} from parsed argv.
 *
 * @property projectRoot canonical root whose stack files are enumerated.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  projectRoot: string;

  json: boolean;

  quiet: boolean;
}

/**
 * Fill in each enumerated stack row's parsed `data`/`prose` in place.
 *
 * Phase-1 enumeration yields the file set with paths but without parsed
 * bodies; the consistency check needs the parsed YAML, so this reads and
 * parses each file and writes the result back onto the row. Mutates the rows
 * inside `snapshot.stackFiles` (its side effect) and returns nothing.
 *
 * A file that cannot be read or parsed is left unhydrated and skipped rather
 * than aborting the run: a malformed file is not this check's concern (it is
 * `lint-stacks`'s), so the invariant check simply proceeds without its body.
 */
function hydrateSnapshot(snapshot: ReturnType<typeof _runPhase1ForTests>): void {
  for (const row of snapshot.stackFiles.values()) {
    let text: string;
    try {
      text = readFileSync(row.path, 'utf8');
    } catch {
      // Unreadable file: leave the row unhydrated; the check tolerates it.
      continue;
    }
    try {
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // Unparseable YAML: same as above — not this script's job to report it.
      continue;
    }
  }
}

/**
 * Enumerate stack files, hydrate them, run the pairs-with consistency check,
 * and render the result.
 *
 * Each {@link checkPairsWithConsistency} issue becomes a {@link ReportFailure},
 * carrying the issue's `field` only when present. The exit code in the
 * returned {@link RunResult} is `SUCCESS` with no violations, else `FAILURE`.
 * Reads the filesystem (via the phase-1 walk and hydration) but does not write.
 *
 * @param opts resolved {@link RunOptions}.
 */
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
 * CLI entrypoint: parse argv, dispatch to {@link run}, and write its output.
 *
 * Returns the exit code rather than calling `process.exit`, so it is testable
 * in-process. `--help` short-circuits with `SUCCESS`; an unknown flag or
 * unexpected positional returns `BAD_ARGS` without running the check.
 * Side effects are limited to writing stdout/stderr.
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
    process.stderr.write(`pair-names: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

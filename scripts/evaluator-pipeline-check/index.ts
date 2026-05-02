#!/usr/bin/env node
/**
 * R4 sprint 3 — `evaluator-pipeline-check` maintainer script (skeleton).
 *
 * E3-bound deterministic-core harness. For each bootstrap fixture under
 * `tests/fixtures/stacks/`, this script:
 *
 *   1. Calls R1's `validateAll({ projectRoot })` directly (per the
 *      single-implementation rule — never re-implements validation).
 *   2. Serialises the result via R1's `stableStringify` (sorted keys,
 *      two-space indent, trailing newline — F3's determinism pin).
 *   3. Diffs that normalised output byte-for-byte against the fixture's
 *      committed `golden.json`. Drift surfaces as a `GoldenDriftDetected`
 *      failure; a missing golden surfaces as `GoldenMissing`.
 *
 * `--update-goldens` re-seeds every golden via R1's `atomicWriteFile`
 * (never raw `fs.writeFileSync`).
 *
 * Per the project context's bootstrap-fixture-set rule, the fixture list
 * is hard-coded — `invariant-*` and `invalid-*` fixtures intentionally
 * fail validation and would corrupt the golden seed if auto-discovered.
 *
 * Exit codes (per `SCRIPT_EXIT`):
 *   - 0 on a clean run (no drift, no missing goldens, or after
 *     `--update-goldens`);
 *   - 1 when one or more fixtures drifted or are missing a golden;
 *   - 64 when the caller passed an unknown flag.
 *
 * Output:
 *   - default: one-line summary on stdout, one line per failure on
 *     stderr (path + code + message).
 *   - `--json`: a sorted-key two-space-indent JSON document on stdout
 *     with the failure list embedded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../src/index.js';
import { atomicWriteFile } from '../../src/config-server/storage/atomic-write.js';
import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  stableStringify,
  type EvaluatorPipelineCheckReport,
  type ReportFailure,
} from '../lib/index.js';

// TODO(E3): broaden the fixture set when E3 ships its full deterministic
// core. The current list is the R1 bootstrap trio — every other fixture
// under `tests/fixtures/stacks/` (e.g. `invariant-*`, `invalid-*`) is
// designed to fail validateAll and would corrupt the seed if added here.
const BOOTSTRAP_FIXTURES = [
  'js-ts-minimal',
  'polyglot-webnode-synthetic',
  'synthetic-second',
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
// Script lives at `dist/scripts/evaluator-pipeline-check/index.js`. After
// `path.dirname`, `here` is `<repo>/dist/scripts/evaluator-pipeline-check`,
// so three `..` segments reach the repo root.
const repoRoot = path.resolve(here, '..', '..', '..');
const defaultFixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

function renderHelp(): string {
  return [
    'Usage: evaluator-pipeline-check [--fixture-root <path>] [--update-goldens]',
    '                                 [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    "Runs R1's `validateAll` against every bootstrap fixture and diffs the",
    "normalised output against the fixture's committed `golden.json`. Drift",
    'or a missing golden produces a non-zero exit. `--update-goldens`',
    "re-seeds every fixture's golden in place via the atomic-write helper.",
    '',
    'Bootstrap fixtures (hard-coded; broadens with E3):',
    '  - js-ts-minimal',
    '  - polyglot-webnode-synthetic',
    '  - synthetic-second',
    '',
    'Options:',
    '  --fixture-root <path>  Override the directory holding the fixture set',
    '                         (default: <repo>/tests/fixtures/stacks).',
    "  --update-goldens       Re-seed every fixture's golden.json in place.",
    '  --project-root <path>  Accepted for arg-parser compatibility; unused.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  All fixtures match their goldens (or --update-goldens succeeded).',
    '  1  At least one fixture drifted or has no golden on disk.',
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
  /** Directory holding the bootstrap fixture set. */
  fixtureRoot: string;
  /** When true, re-seed each fixture's `golden.json` instead of diffing. */
  updateGoldens: boolean;
  /** Emit the report as JSON instead of summary + per-failure stderr. */
  json: boolean;
  /** Suppress the success-path stdout summary. */
  quiet: boolean;
}

function goldenPathFor(fixtureRoot: string, fixture: string): string {
  return path.join(fixtureRoot, fixture, 'golden.json');
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

  for (const fixture of BOOTSTRAP_FIXTURES) {
    const projectRoot = path.join(opts.fixtureRoot, fixture);
    const golden = goldenPathFor(opts.fixtureRoot, fixture);

    const result = validateAll({ projectRoot });
    // TODO(E3): once the harness emits run timestamps and tokens, normalise
    // them out here before stringifying so the golden stays stable.
    const normalised = stableStringify(result);

    if (opts.updateGoldens) {
      atomicWriteFile(golden, normalised);
      continue;
    }

    // TODO(E3): replace the byte-for-byte equality check with a
    // structured diff once E3 lands its richer comparator (line-anchored
    // patches, ignored-key allowlist, etc.).
    const existing = readFileIfExists(golden);
    if (existing === null) {
      failures.push({
        path: golden,
        code: 'GoldenMissing',
        message: `no golden.json — run with --update-goldens to seed; fixture: ${fixture}`,
      });
      continue;
    }
    if (existing !== normalised) {
      const truncated = normalised.slice(0, 200);
      failures.push({
        path: golden,
        code: 'GoldenDriftDetected',
        message: `normalised output differs from golden; first 200 chars of actual: ${truncated}`,
      });
    }
  }

  const report: EvaluatorPipelineCheckReport = {
    kind: 'evaluator-pipeline-check',
    checked: BOOTSTRAP_FIXTURES.length,
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
    boolean: ['json', 'quiet', 'help', 'update-goldens'],
    string: ['fixture-root', 'project-root'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`evaluator-pipeline-check --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`evaluator-pipeline-check --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const fixtureRoot =
    typeof parsed.flags['fixture-root'] === 'string'
      ? (parsed.flags['fixture-root'] as string)
      : defaultFixtureRoot;

  const result = run({
    fixtureRoot,
    updateGoldens: parsed.flags['update-goldens'] === true,
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
    process.stderr.write(`evaluator-pipeline-check: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

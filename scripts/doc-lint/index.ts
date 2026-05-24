#!/usr/bin/env node
/**
 * `doc-lint` CLI — the deterministic documentation gate for the framework's
 * own TypeScript surface, in the R4 lint family.
 *
 * It enforces exactly one binary, no-false-positive rule: every exported
 * symbol a change *introduces* must carry a doc comment. The rule is measured
 * as a delta against the merge-base with the repo's base branch, not as a
 * full-tree scan — a finding fails only when the diff introduces it, so a
 * pre-existing undocumented export is grandfathered and never reported (the
 * ratchet only tightens; it does not retroactively clean). An empty change
 * reports nothing and exits clean.
 *
 * Why delta-vs-merge-base rather than scanning the whole tree: a full-tree
 * scan would block legitimate work on the backlog of historically
 * undocumented exports, which is precisely the "gate an unproven linter and
 * block legit work" failure this tool is designed to avoid. The merge-base is
 * the point the branch diverged from its base, so "introduced by the diff"
 * means "exported here but not at that point".
 *
 * The tool resolves the merge-base itself by shelling `git` through Node's
 * `execFileSync` with an argument array (never an interpolated shell string),
 * so a branch name carrying shell metacharacters cannot be reinterpreted as a
 * command. The base ref is overridable with `--base-ref`; absent that, the
 * tool detects the repo's base branch.
 *
 * Output/exit follow the shared `scripts/lib` contract (`0` clean, `1` an
 * undocumented introduced export, `64` usage error). `run` is exported and
 * read-only (it only reads the filesystem and queries git); `main` owns argv
 * parsing and process I/O.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  type DocLintReport,
  type ReportFailure,
} from '../lib/index.js';

// Stable issue code emitted when the delta introduces an exported symbol with
// no doc comment. Named so tests/CI match on the constant, not the literal.
const MISSING_EXPORT_DOC_CODE = 'MissingExportDoc';

// Base branches tried, in order, when `--base-ref` is not supplied: a branch
// name resolvable in this repo is used as the merge-base partner. `develop` is
// tried before `main` because this repo's git-flow branches diverge from
// `develop`; both are tried so the tool works in either a git-flow or a
// trunk-based repo without configuration.
const DEFAULT_BASE_REF_CANDIDATES = ['develop', 'main'] as const;

// Repo root derived from this compiled module's location (dist/scripts/...),
// so a default project root resolves regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: doc-lint [--base-ref <ref>] [--project-root <path>]',
    '                [--json] [--quiet] [--help]',
    '',
    'Checks the merge-base delta with the base branch and reports every',
    'exported symbol the diff introduces that lacks a doc comment. A',
    'pre-existing undocumented export is grandfathered and never reported.',
    'An empty change reports nothing.',
    '',
    'Options:',
    '  --base-ref <ref>       Resolve the merge-base against this ref instead of',
    '                         the auto-detected base branch (develop, then main).',
    '  --project-root <path>  Inspect this project root instead of the cwd.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No introduced export is missing a doc comment.',
    '  1  At least one introduced export is missing a doc comment.',
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
 * @property projectRoot canonical repo root the git queries and file reads run
 *   against; the merge-base and diff are computed in this working tree.
 * @property baseRef explicit base ref to take the merge-base against, or `null`
 *   to auto-detect from {@link DEFAULT_BASE_REF_CANDIDATES}.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run (failures still
 *   print to stderr).
 */
interface RunOptions {
  projectRoot: string;

  baseRef: string | null;

  json: boolean;

  quiet: boolean;
}

/**
 * Run a `git` subcommand in `cwd` and return trimmed stdout, or `null` on any
 * non-zero exit or spawn error.
 *
 * Uses `execFileSync` with an argv array and no shell, so an argument
 * containing shell metacharacters is passed literally and can never be
 * reinterpreted as a command — the one invariant the subprocess-safety rule
 * turns on. stderr is discarded; a failing git call (e.g. an unknown ref, or
 * a path absent at the base revision) is reported by returning `null` rather
 * than throwing, because the callers treat "git could not answer" as "no
 * baseline information" and degrade gracefully. Read-only w.r.t. the repo.
 *
 * @param cwd working directory the git command runs in.
 * @param args git arguments (without the leading `git`), passed verbatim.
 * @returns trimmed stdout on success, `null` on failure.
 */
function gitTry(cwd: string, args: readonly string[]): string | null {
  try {
    // argv array form (no `shell: true`): arguments are literal, not parsed by
    // a shell, which is what keeps a hostile ref name from injecting a command.
    const out = execFileSync('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString('utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the commit to use as the delta baseline: the merge-base of `HEAD`
 * with the base branch.
 *
 * When `baseRef` is given it is used directly; otherwise each candidate in
 * {@link DEFAULT_BASE_REF_CANDIDATES} is tried in order and the first one that
 * yields a merge-base wins. Returns `null` when no base can be resolved (a
 * shallow clone with no common ancestor, or a repo lacking every candidate
 * branch) — the caller treats that as "no baseline, nothing introduced to
 * measure" and reports a clean run, because the tool must never block on its
 * own inability to find a baseline. Read-only.
 *
 * @param cwd working tree the merge-base is computed in.
 * @param baseRef explicit base ref, or `null` to auto-detect.
 * @returns the merge-base commit sha, or `null` if none resolves.
 */
function resolveMergeBase(cwd: string, baseRef: string | null): string | null {
  const candidates = baseRef !== null ? [baseRef] : DEFAULT_BASE_REF_CANDIDATES;
  for (const ref of candidates) {
    const base = gitTry(cwd, ['merge-base', 'HEAD', ref]);
    if (base !== null && base.length > 0) {
      return base;
    }
  }
  return null;
}

/**
 * List the `.ts`/`.tsx` files that changed between `baseSha` and the working
 * tree (committed, staged, and unstaged changes alike), as repo-relative
 * forward-slashed paths.
 *
 * `git diff --name-only <baseSha>` compares the base against the working tree,
 * so a fixture's uncommitted edit is part of the delta — this is the "diff
 * introduces it" surface the rule measures. Deletions are filtered out by
 * keeping only paths that still exist on disk, since a removed file has no
 * exports to document. Returns `[]` when git cannot answer. Read-only.
 *
 * @param cwd working tree the diff is computed in.
 * @param baseSha the merge-base commit to diff against.
 * @returns sorted repo-relative paths of changed, still-present `.ts`/`.tsx`
 *   files.
 */
function listChangedTsFiles(cwd: string, baseSha: string): string[] {
  // `--` then the pathspecs limits the diff to the TypeScript surface; the
  // globs are literal pathspec args, not shell globs (no shell is involved).
  const out = gitTry(cwd, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    baseSha,
    '--',
    '*.ts',
    '*.tsx',
  ]);
  if (out === null || out.length === 0) {
    return [];
  }
  const rel = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'));

  // Keep only files that still exist on disk. `--diff-filter=d` already drops
  // pure deletions, but a rename's old path can survive in some git versions;
  // the disk check makes "has exports to read" unambiguous.
  const present = rel.filter((r) => {
    try {
      return statSync(path.join(cwd, r)).isFile();
    } catch {
      return false;
    }
  });
  // Deterministic order so the report is byte-reproducible across runs.
  present.sort();
  return present;
}

/** One exported symbol found in a source file: its `name` and whether a doc comment precedes it. */
interface ExportSymbol {
  name: string;

  documented: boolean;
}

// Matches a top-level `export` declaration line and captures the symbol name.
// Deliberately line-anchored to module-level (no leading indentation) so a
// nested `export` inside a namespace body — and member declarations indented
// within a class — are not mistaken for module exports. The alternatives cover
// the declaration forms whose name is decidable from the line itself:
// function/class/interface/type/enum and const/let/var bindings, optionally
// `default`/`async`/`abstract`-qualified.
const EXPORT_DECL_RE =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/**
 * Extract the module-level exported symbols from TypeScript `source`, each
 * tagged with whether a doc comment immediately precedes its declaration.
 *
 * "Doc comment" means a block comment (`/* ... *\/`, including the JSDoc
 * `/** ... *\/` form) whose closing line is the line directly above the
 * `export`, allowing only blank lines between. A line comment (`//`) does not
 * count, matching the doc-comment convention the rest of this surface follows.
 *
 * Only named single-symbol declarations are considered, because the rule is
 * "this introduced export is documented" and only those forms carry a name
 * decidable without a full parser. Re-export statements (`export { … }`,
 * `export * from …`) and destructuring exports are intentionally skipped: they
 * either re-surface a symbol documented at its definition or have no single
 * name to attribute a doc comment to — flagging them would be a false
 * positive, and this rule admits none. Pure; parses the string only.
 *
 * @param source the file contents to scan.
 * @returns one {@link ExportSymbol} per detected module-level named export.
 */
function extractExports(source: string): ExportSymbol[] {
  const lines = source.split(/\r?\n/);
  const symbols: ExportSymbol[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = EXPORT_DECL_RE.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    symbols.push({ name, documented: hasDocCommentAbove(lines, i) });
  }
  return symbols;
}

/**
 * Decide whether a block doc comment immediately precedes the declaration at
 * `declIdx`, skipping only blank lines in between.
 *
 * Walks upward from the line above the declaration: blank lines are skipped,
 * and the first non-blank line must end a block comment (`*\/`) for the
 * declaration to count as documented. Anything else above it (code, a line
 * comment, or nothing) means undocumented. This mirrors how a reader
 * associates a doc block with the symbol directly beneath it. Pure.
 *
 * @param lines the file split into lines.
 * @param declIdx index of the `export` declaration line.
 * @returns `true` if a block comment closes directly above the declaration.
 */
function hasDocCommentAbove(lines: readonly string[], declIdx: number): boolean {
  let i = declIdx - 1;
  while (i >= 0 && lines[i]!.trim().length === 0) {
    i -= 1;
  }
  if (i < 0) return false;
  return lines[i]!.trim().endsWith('*/');
}

/**
 * Scan the merge-base delta and report every introduced export missing a doc
 * comment, returning a rendered {@link RunResult}.
 *
 * The delta semantics are the load-bearing correctness property: for each
 * `.ts`/`.tsx` file changed since the merge-base, the set of exported symbol
 * names *at the merge-base* is read via `git show <base>:<path>` and used to
 * grandfather pre-existing exports. An undocumented export is reported only
 * when its name is absent from that baseline set — i.e. the diff introduced
 * it. A documented introduced export, and any pre-existing export (documented
 * or not), produce no finding.
 *
 * When no merge-base resolves (see {@link resolveMergeBase}) or the change set
 * is empty, there is nothing the diff introduced, so the run is clean. Exit is
 * `SUCCESS` with no findings, else `FAILURE`. Read-only: reads files and
 * queries git, never writes the repo or calls `process.exit`.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];

  const baseSha = resolveMergeBase(opts.projectRoot, opts.baseRef);
  if (baseSha === null) {
    // No baseline → nothing "introduced" to measure → clean. The tool must
    // never fail merely because it could not locate a base ref.
    return finalize({ kind: 'doc-lint', checked: 0, failures }, opts);
  }

  const changed = listChangedTsFiles(opts.projectRoot, baseSha);
  for (const rel of changed) {
    const abs = path.join(opts.projectRoot, rel);
    let current: string;
    try {
      current = readFileSync(abs, 'utf8');
    } catch {
      // Listed by the diff but unreadable now: skip rather than fail — there
      // is no content to judge, and an unreadable file is not an undoc export.
      continue;
    }

    // The grandfather set: export names present at the merge-base. A file that
    // did not exist at the base (newly added) yields `null` here, so every
    // export in it is "introduced". `git show` argv is literal — no shell.
    const baseSource = gitTry(opts.projectRoot, ['show', `${baseSha}:${rel}`]);
    const baselineNames = new Set(
      baseSource === null ? [] : extractExports(baseSource).map((s) => s.name),
    );

    for (const sym of extractExports(current)) {
      const introduced = !baselineNames.has(sym.name);
      if (introduced && !sym.documented) {
        failures.push({
          path: abs,
          code: MISSING_EXPORT_DOC_CODE,
          field: sym.name,
          message:
            `exported symbol '${sym.name}' in ${rel} is introduced by this change ` +
            `without a doc comment. Add a doc comment describing it directly above ` +
            `the export, or run the framework's doc-lint check to see the full list.`,
        });
      }
    }
  }

  return finalize({ kind: 'doc-lint', checked: changed.length, failures }, opts);
}

/**
 * Turn a finished report into a {@link RunResult}: sort findings into a
 * deterministic order, render (JSON vs. human), suppress the clean-run stdout
 * summary under `--quiet`, and derive the exit code (`SUCCESS` iff there are no
 * findings, else `FAILURE`).
 *
 * Findings are sorted by `path` then `field` (the symbol name) so two runs over
 * the same diff emit byte-identical output regardless of filesystem or git
 * enumeration order — the determinism the report contract requires. Pure
 * w.r.t. process state.
 *
 * @param report the assembled doc-lint report; its `failures` are sorted in
 *   place before rendering (a mutation confined to this freshly built array).
 * @param opts resolved {@link RunOptions} controlling json/quiet rendering.
 */
function finalize(report: DocLintReport, opts: RunOptions): RunResult {
  report.failures.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const af = a.field ?? '';
    const bf = b.field ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    return 0;
  });

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
 * unexpected positional returns `BAD_ARGS` before any git/file work. The
 * `--project-root` override is resolved to an absolute path (a testing seam
 * lets a suite point the tool at a fixture repo); `--base-ref`, when absent,
 * leaves `run` to auto-detect the base branch. Side effect: writing
 * stdout/stderr.
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help'],
    string: ['project-root', 'base-ref'],
  });

  if (parsed.flags['help'] === true) {
    process.stdout.write(renderHelp());
    return SCRIPT_EXIT.SUCCESS;
  }

  if (parsed.unknown.length > 0) {
    const offender = parsed.unknown[0]!;
    process.stderr.write(
      `Error: unknown argument '${offender}'. Run \`doc-lint --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  if (parsed.positionals.length > 0) {
    const offender = parsed.positionals[0]!;
    process.stderr.write(
      `Error: unexpected argument '${offender}'. Run \`doc-lint --help\` for usage.\n`,
    );
    return SCRIPT_EXIT.BAD_ARGS;
  }

  const projectRoot =
    typeof parsed.flags['project-root'] === 'string'
      ? path.resolve(parsed.flags['project-root'] as string)
      : repoRoot;

  const baseRef =
    typeof parsed.flags['base-ref'] === 'string' ? (parsed.flags['base-ref'] as string) : null;

  const result = run({
    projectRoot,
    baseRef,
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
// can never masquerade as success. Guarded so importing this module for tests
// does not spawn the CLI: only a direct `node dist/.../index.js` invocation
// (where argv[1] is this file) runs main.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`doc-lint: fatal: ${msg}\n`);
      process.exit(SCRIPT_EXIT.FAILURE);
    },
  );
}

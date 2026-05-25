#!/usr/bin/env node
/**
 * `doc-lint` CLI — the deterministic documentation gate for the framework's
 * own TypeScript surface, in the R4 lint family.
 *
 * It enforces exactly one binary, no-false-positive rule at *blocker*
 * severity: every exported symbol a change *introduces* must carry a doc
 * comment. The rule is measured as a delta against the merge-base with the
 * repo's base branch, not as a full-tree scan — a finding fails only when the
 * diff introduces it, so a pre-existing undocumented export is grandfathered
 * and never reported (the ratchet only tightens; it does not retroactively
 * clean). An empty change reports nothing and exits clean.
 *
 * Alongside the blocker, it runs two *advisory* heuristics in the same pass:
 * required-sections (a function's doc should document its params/return) and
 * commented-out-code (a comment that looks like disabled source). These are
 * report-only: they are parser/quoting heuristics with known false-positive
 * surfaces, so each advisory finding states its FP caveat in the message and,
 * on its own, never drives a non-zero exit. The exit code is routed by
 * severity — advisory-only is clean (`SUCCESS`); only a blocker fails
 * (`FAILURE`) — and any advisory findings that fired in the same run are still
 * reported alongside a blocker, never suppressed by nor suppressing it.
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
 * Output/exit follow the shared `scripts/lib` contract (`0` clean OR
 * advisory-only, `1` at least one blocker, `64` usage error). `run` is
 * exported and read-only (it only reads the filesystem and queries git);
 * `main` owns argv parsing and process I/O.
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

// Stable issue code for the required-sections advisory: an introduced exported
// function whose doc comment documents neither its parameters nor its return.
const INCOMPLETE_DOC_SECTIONS_CODE = 'IncompleteDocSections';

// Stable issue code for the commented-out-code advisory: an introduced comment
// line that appears to hold disabled source rather than prose.
const COMMENTED_OUT_CODE_CODE = 'CommentedOutCode';

// The shared FP-caveat sentence reused across advisory findings: it states
// plainly that the rule is a heuristic and reported (not gating) so a reader
// is not misled into treating an advisory as a hard error. Centralised so the
// honesty contract reads identically wherever an advisory finding is built.
const ADVISORY_PREFIX =
  'advisory (reported, not blocking): this is a heuristic and can misfire';

// Base branches tried, in order, when `--base-ref` is not supplied: the first
// candidate that yields a merge-base is the partner. Local branch names come
// first (a developer's working clone has `develop`/`main` as local branches);
// the `origin/`-prefixed forms follow so a fresh CI checkout — where the base
// exists only as a remote-tracking ref and `HEAD` is detached — still resolves
// without an explicit `--base-ref`. `develop` precedes `main` because this
// repo's branches diverge from `develop`; both are tried so the tool works in a
// git-flow or a trunk-based repo without configuration.
const DEFAULT_BASE_REF_CANDIDATES = [
  'develop',
  'main',
  'origin/develop',
  'origin/main',
] as const;

// Repo root derived from this compiled module's location (dist/scripts/...),
// so a default project root resolves regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: doc-lint [--base-ref <ref>] [--require-base] [--project-root <path>]',
    '                [--json] [--quiet] [--help]',
    '',
    'Checks the merge-base delta with the base branch. It reports, at blocker',
    'severity, every exported symbol the diff introduces that lacks a doc',
    'comment, and at advisory severity two heuristics: a function whose doc',
    'documents no params/return, and a comment that looks like commented-out',
    'code. A pre-existing finding is grandfathered and never reported; an empty',
    'change reports nothing. Advisory findings, on their own, do not fail.',
    '',
    'Options:',
    '  --base-ref <ref>       Resolve the merge-base against this ref instead of',
    '                         the auto-detected base branch (develop, then main,',
    '                         then their origin/ forms).',
    '  --require-base         Fail (non-zero) instead of reporting clean when no',
    '                         base ref resolves. Use in a gate so a missing',
    '                         baseline (e.g. a shallow checkout) fails loudly',
    '                         rather than silently passing every change.',
    '  --project-root <path>  Inspect this project root instead of the cwd.',
    '  --json                 Emit the report as a JSON document on stdout.',
    '  --quiet                Suppress the stdout summary on a clean run.',
    '  --help                 Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  No blocker finding (a clean delta, or advisory findings only).',
    '  1  At least one blocker finding (an introduced export missing its doc).',
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
 * @property requireBase fail loudly (non-zero) when no base ref resolves,
 *   instead of degrading to a clean run. A local developer run leaves this off
 *   so an unusual git layout does not fail their machine; a gating run (CI)
 *   sets it so the tool can never certify a change it never measured — a silent
 *   clean on a shallow checkout would pass every change and defeat the gate.
 */
interface RunOptions {
  projectRoot: string;

  baseRef: string | null;

  json: boolean;

  quiet: boolean;

  requireBase: boolean;
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
 * branch). How the caller handles `null` depends on `requireBase`: a plain run
 * degrades to a clean report (no baseline, nothing introduced to measure),
 * while a gating run refuses loudly (see {@link run}) so it never certifies a
 * change it could not measure. Read-only.
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

// Matches a top-level exported *function* declaration and captures its name.
// Required-sections only judges functions (the rule is about params/return), so
// it uses a narrower pattern than EXPORT_DECL_RE rather than re-classifying that
// regex's broader output — keeping the presence rule's matching untouched.
const EXPORT_FUNCTION_RE =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/;

/**
 * Collect the {@link INCOMPLETE_DOC_SECTIONS_CODE} advisory for each introduced
 * exported function whose preceding doc block documents neither a parameter nor
 * a return.
 *
 * The check is intentionally shallow: a function counts as documenting its
 * sections if the doc block above it contains an `@param` or `@returns`/
 * `@return` tag. This is a heuristic, not a sound rule — hence advisory — and
 * its false-positive surface is named in the finding text (a function that
 * documents its arguments in prose rather than with an explicit `@param`, a
 * destructured or rest parameter, an overload signature, and a re-export all
 * read as "no sections" here yet may be perfectly documented). It only fires on
 * a function whose name is *introduced* by the delta (absent from
 * `baselineNames`), matching the ratchet the presence rule uses.
 *
 * Pure w.r.t. its inputs; appends advisory rows to `failures`.
 *
 * @param source the current file contents.
 * @param baselineNames export names present at the merge-base (the grandfather
 *   set; a name in it is pre-existing, so not judged).
 * @param abs absolute path used as the finding `path`.
 * @param rel repo-relative path used in the human message.
 * @param failures the shared finding accumulator the advisory rows are pushed to.
 */
function collectRequiredSectionsAdvisories(
  source: string,
  baselineNames: ReadonlySet<string>,
  abs: string,
  rel: string,
  failures: ReportFailure[],
): void {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = EXPORT_FUNCTION_RE.exec(lines[i]!);
    if (match === null) continue;
    const name = match[1]!;
    // Grandfather pre-existing functions: only an introduced one is judged.
    if (baselineNames.has(name)) continue;
    const doc = docBlockTextAbove(lines, i);
    // No doc block at all is the presence blocker's job, not this advisory's —
    // flagging it here too would double-report the same symbol.
    if (doc === null) continue;
    const documentsSections = /@param\b/.test(doc) || /@returns?\b/.test(doc);
    if (documentsSections) continue;
    failures.push({
      path: abs,
      code: INCOMPLETE_DOC_SECTIONS_CODE,
      field: name,
      severity: 'advisory',
      message:
        `${ADVISORY_PREFIX}. The doc comment for the function '${name}' in ${rel} ` +
        `documents no parameter or return value via an '@param' or '@returns' tag. ` +
        `It may already be well documented — this check cannot soundly tell, because ` +
        `destructured or rest parameters, overload signatures, a re-export of a symbol ` +
        `documented elsewhere, and parameters described in prose rather than an explicit ` +
        `'@param' tag all read as undocumented here. Treat it as a prompt to review, not a ` +
        `gate. Review the doc comment and add '@param'/'@returns' tags if they are missing.`,
    });
  }
}

/**
 * Return the text of the block doc comment immediately above the declaration at
 * `declIdx` (joined with newlines), or `null` when none precedes it.
 *
 * Walks upward past blank lines to find a `*\/` close, then continues up to the
 * matching `/*` open, and returns the inclusive span. Used by the
 * required-sections heuristic to read what a function's doc block actually
 * says; it deliberately reuses the same "block comment, blank lines allowed"
 * association {@link hasDocCommentAbove} uses, so the two agree on what counts
 * as the doc block. Pure.
 *
 * @param lines the file split into lines.
 * @param declIdx index of the declaration line.
 * @returns the doc-block text, or `null` if the declaration has no block comment
 *   directly above it.
 */
function docBlockTextAbove(lines: readonly string[], declIdx: number): string | null {
  let i = declIdx - 1;
  while (i >= 0 && lines[i]!.trim().length === 0) {
    i -= 1;
  }
  if (i < 0 || !lines[i]!.trim().endsWith('*/')) return null;
  const end = i;
  // Walk up to the comment open. A single-line `/** ... *\/` has open and close
  // on the same line, so the loop body's start-of-block test fires immediately.
  while (i >= 0 && !lines[i]!.trim().startsWith('/*')) {
    i -= 1;
  }
  if (i < 0) return null;
  return lines.slice(i, end + 1).join('\n');
}

// Matches a line that is *only* a `//` comment (optionally indented), capturing
// the commented text. A trailing `//` on a code line is not a candidate for the
// commented-out-code heuristic, because the code beside it is live.
const LINE_COMMENT_RE = /^\s*\/\/\s?(.*)$/;

// Heuristic signals that a `//`-commented line holds disabled *code* rather than
// prose: it ends in a statement terminator/opener (`; { } ,`), or it looks like
// a control/declaration/assignment construct. Anchored and conservative on
// purpose — the rule is advisory, and the message names the FP cases (an
// `@example` snippet, prose quoting code, a bare URL) it cannot rule out.
const CODE_LOOKING_PATTERNS: readonly RegExp[] = [
  /[;{}]\s*$/, // statement terminator or block brace at end of line
  /^(?:const|let|var|function|class|return|import|export|if|for|while|switch)\b/,
  /^[A-Za-z_$][\w$.]*\s*=[^=]/, // an assignment (not `==`/`===`)
  /^[A-Za-z_$][\w$.]*\([^)]*\)\s*;?\s*$/, // a bare function-call statement
];

/**
 * Collect the {@link COMMENTED_OUT_CODE_CODE} advisory for each delta-introduced
 * `//` comment line that appears to hold disabled source code.
 *
 * Delta scoping mirrors the presence rule: the set of trimmed comment lines
 * present at the merge-base (`baseSource`) is the grandfather set, so a
 * pre-existing commented-out line is never reported — only one the diff
 * introduces. A line qualifies when, stripped of its `//`, it matches a
 * {@link CODE_LOOKING_PATTERNS} signal. Because that test cannot distinguish a
 * snippet shown intentionally inside an `@example`, prose that quotes a code
 * fragment, or a URL that happens to contain code-like punctuation, the rule is
 * advisory and the finding text names exactly those cases. To avoid one
 * disabled block producing a wall of near-identical rows, at most one finding
 * is emitted per file (the first introduced code-looking comment), with the
 * line number cited so the author can find it. Pure w.r.t. its inputs.
 *
 * @param source the current file contents.
 * @param baseSource the file contents at the merge-base, or `null` if the file
 *   did not exist there (then every comment line is introduced).
 * @param abs absolute path used as the finding `path`.
 * @param rel repo-relative path used in the human message.
 * @param failures the shared finding accumulator the advisory row is pushed to.
 */
function collectCommentedOutCodeAdvisories(
  source: string,
  baseSource: string | null,
  abs: string,
  rel: string,
  failures: ReportFailure[],
): void {
  const baselineComments = new Set<string>();
  if (baseSource !== null) {
    for (const line of baseSource.split(/\r?\n/)) {
      const m = LINE_COMMENT_RE.exec(line);
      if (m !== null) baselineComments.add(m[1]!.trim());
    }
  }

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = LINE_COMMENT_RE.exec(lines[i]!);
    if (m === null) continue;
    const body = m[1]!.trim();
    if (body.length === 0) continue;
    // Grandfather a comment line that already existed at the base.
    if (baselineComments.has(body)) continue;
    if (!looksLikeCode(body)) continue;
    failures.push({
      path: abs,
      code: COMMENTED_OUT_CODE_CODE,
      // 1-based line so a reader can jump to it; `field` keeps the report shape.
      field: `${rel}:${i + 1}`,
      severity: 'advisory',
      message:
        `${ADVISORY_PREFIX}. A comment introduced at ${rel}:${i + 1} looks like commented-out ` +
        `code. It may be intentional — this check cannot soundly tell, because a code snippet ` +
        `inside an '@example' block, prose that quotes a fragment of code, and a URL that ` +
        `resembles code all read as commented-out code here. Treat it as a prompt to review, ` +
        `not a gate. If the code is dead, delete it; if it is illustrative, an '@example' tag ` +
        `or surrounding prose makes the intent clear.`,
    });
    // One finding per file: a disabled block is many such lines, and the author
    // acts on the file once. The cited line points at the first occurrence.
    return;
  }
}

/**
 * Decide whether the body of a `//` comment (already stripped of its leading
 * `//`) looks like disabled source code rather than prose, by matching any
 * {@link CODE_LOOKING_PATTERNS} signal. Deliberately conservative: a false
 * negative (missing some commented-out code) is preferred to a false positive,
 * since the rule is advisory and over-reporting erodes its signal. Pure.
 *
 * @param body the comment text with its `//` and surrounding whitespace removed.
 * @returns `true` if the text matches a code-shaped pattern.
 */
function looksLikeCode(body: string): boolean {
  for (const re of CODE_LOOKING_PATTERNS) {
    if (re.test(body)) return true;
  }
  return false;
}

/**
 * Scan the merge-base delta and report the export-doc-presence blocker plus the
 * two advisory heuristics, returning a rendered {@link RunResult}.
 *
 * The delta semantics are the load-bearing correctness property: for each
 * `.ts`/`.tsx` file changed since the merge-base, the set of exported symbol
 * names *at the merge-base* is read via `git show <base>:<path>` and used to
 * grandfather pre-existing exports. An undocumented export is reported (as a
 * blocker) only when its name is absent from that baseline set — i.e. the diff
 * introduced it. A documented introduced export, and any pre-existing export
 * (documented or not), produce no blocker. The same delta scoping bounds the
 * advisory heuristics (see their collectors), so they too report only what the
 * diff introduces.
 *
 * When no merge-base resolves (see {@link resolveMergeBase}) or the change set
 * is empty, there is nothing the diff introduced, so the run is clean. The exit
 * code is routed by severity in {@link finalize} (advisory-only is `SUCCESS`,
 * any blocker is `FAILURE`). Read-only: reads files and queries git, never
 * writes the repo or calls `process.exit`.
 *
 * @param opts resolved {@link RunOptions}.
 */
export function run(opts: RunOptions): RunResult {
  const failures: ReportFailure[] = [];

  const baseSha = resolveMergeBase(opts.projectRoot, opts.baseRef);
  if (baseSha === null) {
    // No baseline resolved. The right response depends on the caller:
    //  - a gating run sets `requireBase` and must refuse loudly — certifying a
    //    change it never measured (a silent clean) would pass everything and
    //    make the gate worthless, which is exactly the false-assurance failure
    //    a gate exists to prevent;
    //  - a local developer run leaves it off and degrades to clean, so an
    //    unusual git layout does not fail their machine.
    if (opts.requireBase) {
      const tried = opts.baseRef !== null ? opts.baseRef : DEFAULT_BASE_REF_CANDIDATES.join(', ');
      return {
        stdout: '',
        stderr:
          `doc-lint: could not resolve a base ref to measure this change against ` +
          `(tried: ${tried}). The documentation gate compares against the base branch and ` +
          `cannot certify a change without it — a shallow checkout omits the base branch's ` +
          `history. Fetch the base branch with full history and retry. Refusing to report a ` +
          `clean result without a baseline.\n`,
        code: SCRIPT_EXIT.FAILURE,
      };
    }
    // No baseline → nothing "introduced" to measure → clean.
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
          // The lone blocker: a binary, no-FP rule, so it gates.
          severity: 'blocker',
          message:
            `exported symbol '${sym.name}' in ${rel} is introduced by this change ` +
            `without a doc comment. Add a doc comment describing it directly above ` +
            `the export, or run the framework's doc-lint check to see the full list.`,
        });
      }
    }

    // The two advisory heuristics run over the same delta, in the same pass, so
    // a single invocation surfaces blocker and advisories together. They append
    // to the same `failures` array; severity (not the array) is what routes the
    // exit code in `finalize`.
    collectRequiredSectionsAdvisories(current, baselineNames, abs, rel, failures);
    collectCommentedOutCodeAdvisories(current, baseSource, abs, rel, failures);
  }

  return finalize({ kind: 'doc-lint', checked: changed.length, failures }, opts);
}

/**
 * Decide the process exit code for a finished report by *severity*, not by
 * finding count.
 *
 * The advisory model's load-bearing rule: a run whose only findings are
 * advisory is clean (`SUCCESS`), so a CI gate built on this tool never blocks
 * on a heuristic's false positive; a run with at least one blocker fails
 * (`FAILURE`). A finding with no `severity` is treated as a blocker, so a
 * finding that predates the `severity` field keeps blocking behaviour rather
 * than silently downgrading to advisory. Pure.
 *
 * @param failures the report's findings (already assembled).
 * @returns `SCRIPT_EXIT.FAILURE` if any finding is a blocker, else
 *   `SCRIPT_EXIT.SUCCESS`.
 */
function exitCodeForFindings(failures: readonly ReportFailure[]): number {
  const hasBlocker = failures.some((f) => f.severity !== 'advisory');
  return hasBlocker ? SCRIPT_EXIT.FAILURE : SCRIPT_EXIT.SUCCESS;
}

/**
 * Turn a finished report into a {@link RunResult}: sort findings into a
 * deterministic order, render (JSON vs. human), suppress the clean-run stdout
 * summary under `--quiet`, and derive the exit code by severity (see
 * {@link exitCodeForFindings}: advisory-only is clean, any blocker fails).
 *
 * Findings are sorted by `path`, then `field`, then `code` so two runs over the
 * same diff emit byte-identical output regardless of filesystem or git
 * enumeration order — the determinism the report contract requires. `code` is
 * the final tiebreak so a blocker and an advisory that share a `path`/`field`
 * (e.g. a function flagged for both) still order deterministically now that
 * three finding classes can interleave. Pure w.r.t. process state.
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
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });

  // The clean-run check is "no findings at all" so an advisory-only run still
  // prints its summary (the advisories ARE the output); the exit code is the
  // separate severity decision in `exitCodeForFindings`.
  const noFindings = report.failures.length === 0;

  if (opts.json) {
    return {
      stdout: formatReportJson(report),
      stderr: '',
      code: exitCodeForFindings(report.failures),
    };
  }
  const formatted = formatReport(report);
  const stdout = opts.quiet && noFindings ? '' : formatted.stdout;
  return {
    stdout,
    stderr: formatted.stderr,
    code: exitCodeForFindings(report.failures),
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
    boolean: ['json', 'quiet', 'help', 'require-base'],
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
    requireBase: parsed.flags['require-base'] === true,
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

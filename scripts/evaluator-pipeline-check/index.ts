#!/usr/bin/env node
/**
 * `evaluator-pipeline-check` CLI — golden-file regression test for the
 * deterministic evaluator core (E3, `src/agents/evaluator-core`).
 *
 * For each of a fixed set of bootstrap fixtures ({@link KNOWN_FIXTURES}), it
 * assembles the core's three inputs from the fixture on disk (resolved config +
 * stacks → snapshot, `sprint-plan.json` → sprint plan, a worktree walk →
 * file set), runs {@link buildEvaluatorPlan}, normalises the output through
 * caller-supplied rules, and diffs it byte-for-byte against the fixture's
 * committed `expected-evaluator-plan.json`. Any drift, or a missing golden,
 * fails the run; `--update-goldens` instead re-seeds every golden in place.
 *
 * Two invariants shape the behaviour:
 * - **Determinism.** Everything that feeds the comparison is sorted and
 *   canonicalised (worktree order, normalise-rule array sorts, stableStringify)
 *   so the golden bytes are reproducible; a non-deterministic diff would be a
 *   false failure.
 * - **A multi-stack guard rail.** The fixture set is hard-coded so coverage
 *   cannot silently shrink. A missing fixture fails unless
 *   `--allow-guardrail-removal` is passed, and that escape hatch is itself
 *   refused under `CI=1` so the guard rail cannot be disarmed in CI.
 *
 * Output/exit follow the shared `scripts/lib` contract (`0`/`1`/`64`). `run`
 * and `main` are async (config resolution is async); `main` owns argv + I/O.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import picomatch from 'picomatch';

import { buildEvaluatorPlan } from '../../src/agents/evaluator-core/index.js';
import type {
  DocLintCmd,
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SecuritySurface,
  SprintPlan,
  WorktreeState,
} from '../../src/agents/evaluator-core/index.js';
import { atomicWriteFile } from '../../src/config-server/storage/atomic-write.js';
import { composeResolvedConfig } from '../../src/config-server/resolution/resolved-config.js';
import { loadStack } from '../../src/config-server/storage/stack-loader.js';
import {
  formatReport,
  formatReportJson,
  parseArgs,
  SCRIPT_EXIT,
  stableStringify,
  type EvaluatorPipelineCheckReport,
  type ReportFailure,
} from '../lib/index.js';

// The guard-rail fixture set, hard-coded on purpose: these are the bootstrap
// scenarios that must always be exercised, so a fixture disappearing from disk
// is a reportable removal rather than a quietly smaller run. The list spans the
// stack-detection cases (generic fallback, JS/TS, packaged-non-web, polyglot,
// plus a second synthetic) the core must keep handling.
const KNOWN_FIXTURES = [
  'generic-fallback',
  'js-ts-minimal',
  'node-packaged-non-web',
  'polyglot-webnode-synthetic',
  'synthetic-second',
] as const;

// Repo root and default fixture/rules paths derived from this module's compiled
// location, so the defaults work regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');
const defaultFixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const defaultNormaliseRules = path.join(repoRoot, 'tests', 'fixtures', 'normalise-rules.json');

/** Build the `--help` text. Pure; returns the usage block as a single string. */
function renderHelp(): string {
  return [
    'Usage: evaluator-pipeline-check [--fixture-root <path>] [--normalise-rules <path>]',
    '                                 [--update-goldens] [--allow-guardrail-removal]',
    '                                 [--project-root <path>] [--json] [--quiet] [--help]',
    '',
    'Runs the E3 deterministic core (`src/agents/evaluator-core`) against',
    'every bootstrap fixture and diffs the normalised output against the',
    "fixture's committed `expected-evaluator-plan.json`. Drift or a",
    'missing golden produces a non-zero exit. `--update-goldens` re-seeds',
    "every fixture's golden in place via the atomic-write helper.",
    '',
    'Bootstrap fixtures (hard-coded — removing one requires --allow-guardrail-removal):',
    ...KNOWN_FIXTURES.map((f) => `  - ${f}`),
    '',
    'Options:',
    '  --fixture-root <path>          Override the directory holding the fixture set',
    '                                 (default: <repo>/tests/fixtures/stacks).',
    '  --normalise-rules <path>       Override the normalise-rules JSON path',
    '                                 (default: <repo>/tests/fixtures/normalise-rules.json).',
    "  --update-goldens               Re-seed every fixture's expected-evaluator-plan.json",
    '                                 in place. Idempotent: a second run produces no diff.',
    '  --allow-guardrail-removal      Permit the run to continue when a known fixture is',
    '                                 missing on disk. Refused under CI=1.',
    '  --project-root <path>          Accepted for arg-parser compatibility; unused.',
    '  --json                         Emit the report as a JSON document on stdout.',
    '  --quiet                        Suppress the stdout summary on a clean run.',
    '  --help                         Print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  All fixtures match their goldens (or --update-goldens succeeded).',
    '  1  At least one fixture drifted, is missing a golden, or has been removed.',
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
 * @property fixtureRoot directory holding the fixture set.
 * @property normaliseRulesPath path to the JSON normalise-rules file.
 * @property updateGoldens re-seed every golden in place instead of diffing.
 * @property allowGuardrailRemoval tolerate a missing known fixture (skipped
 *   rather than failed) — but see `ci`.
 * @property ci whether `CI=1`; when set, `allowGuardrailRemoval` is *refused*
 *   so the guard rail cannot be disarmed in CI.
 * @property json emit the report as JSON instead of the human summary.
 * @property quiet suppress the stdout summary on a clean run.
 */
interface RunOptions {
  fixtureRoot: string;

  normaliseRulesPath: string;

  updateGoldens: boolean;

  allowGuardrailRemoval: boolean;

  ci: boolean;

  json: boolean;

  quiet: boolean;
}

/** Absolute path to a fixture's committed golden (`expected-evaluator-plan.json`). */
function goldenPathFor(fixtureRoot: string, fixture: string): string {
  return path.join(fixtureRoot, fixture, 'expected-evaluator-plan.json');
}

/** Read a file as UTF-8 or return `null` if it is absent/unreadable; never throws. */
function readFileIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The normalisation rules applied to an evaluator plan before comparison, so
 * incidental ordering differences do not read as drift.
 *
 * @property sortArrays each names a top-level array `path` and the key(s) `by`
 *   which to stably sort its objects.
 * @property sortInPlace dotted paths (supporting an `[*]` array-spread segment)
 *   to string arrays that are sorted lexically in place.
 * @property stripPrefixes regex source strings; each is anchored with `^` and
 *   stripped from the front of every string in the document (e.g. to remove an
 *   absolute-path prefix that varies by machine).
 */
interface NormaliseRules {
  sortArrays: Array<{ path: string; by: string | string[] }>;
  sortInPlace: string[];
  stripPrefixes: string[];
}

/**
 * Load and shape the normalise-rules file. Reads `rulesPath` and parses it as
 * JSON (both may throw — the caller catches and reports
 * `NormaliseRulesUnreadable`), then coerces each field to a safe default so a
 * partial or odd-typed file degrades to "no rule of that kind" rather than
 * crashing later.
 */
function loadNormaliseRules(rulesPath: string): NormaliseRules {
  const raw = readFileSync(rulesPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<NormaliseRules>;
  return {
    sortArrays: Array.isArray(parsed.sortArrays) ? parsed.sortArrays : [],
    sortInPlace: Array.isArray(parsed.sortInPlace) ? parsed.sortInPlace : [],
    stripPrefixes: Array.isArray(parsed.stripPrefixes) ? parsed.stripPrefixes : [],
  };
}

/**
 * Return a normalised copy of `plan` with `rules` applied in order: top-level
 * array sorts, then in-place string-array sorts, then prefix stripping.
 *
 * Operates on a deep clone (JSON round-trip) so the caller's plan is untouched;
 * the clone is then mutated by each rule and returned. The purpose is to erase
 * differences that are not semantically meaningful (array order, machine-
 * specific path prefixes) before the byte comparison, so only real drift fails.
 */
function applyNormaliseRules(plan: EvaluatorPlan, rules: NormaliseRules): EvaluatorPlan {
  // Clone via JSON round-trip: the plan is JSON-shaped, and this both isolates
  // the caller's object and lets the rule loops mutate freely.
  const cloned = JSON.parse(JSON.stringify(plan)) as EvaluatorPlan;

  for (const rule of rules.sortArrays) {
    const arr = (cloned as unknown as Record<string, unknown>)[rule.path];
    if (!Array.isArray(arr)) continue;
    // Multi-key sort: compare by each key in turn, falling through to the next
    // only on a tie. Non-string key values collapse to '' so heterogeneous
    // entries still order deterministically. `numeric: false` keeps the sort a
    // pure code-point compare (so it matches the byte-level golden comparison)
    // rather than treating digit runs as numbers.
    const keys = Array.isArray(rule.by) ? rule.by : [rule.by];
    arr.sort((a, b) => {
      for (const k of keys) {
        const av = (a as Record<string, unknown>)[k];
        const bv = (b as Record<string, unknown>)[k];
        const as = typeof av === 'string' ? av : '';
        const bs = typeof bv === 'string' ? bv : '';
        const cmp = as.localeCompare(bs, undefined, { sensitivity: 'variant', numeric: false });
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  for (const inPlacePath of rules.sortInPlace) {
    sortInPlaceByPath(cloned as unknown, inPlacePath);
  }

  if (rules.stripPrefixes.length > 0) {
    const compiled = rules.stripPrefixes.map((p) => new RegExp('^' + p));
    stripPrefixesDeep(cloned as unknown, compiled);
  }

  return cloned;
}

/**
 * Sort a string array reached by `dottedPath` in place. Thin entry point that
 * splits the path and delegates to the recursive {@link walkAndSort}.
 */
function sortInPlaceByPath(root: unknown, dottedPath: string): void {
  const segments = dottedPath.split('.');
  walkAndSort(root, segments, 0);
}

/**
 * Recursively follow `segments` from `idx` and, at the leaf, sort the reached
 * array in place — but only when every element is a string (a mixed array is
 * left alone, since lexical sorting non-strings would be meaningless).
 *
 * A segment of the form `name[*]` is an array-spread: it descends into the
 * array at `name` and recurses into *each* element, so a path can sort string
 * arrays nested inside every object of an intermediate array. Any segment that
 * does not match the current node's shape ends that branch silently. Mutates
 * the matched arrays; returns nothing.
 */
function walkAndSort(node: unknown, segments: string[], idx: number): void {
  if (idx >= segments.length) {
    if (Array.isArray(node)) {
      const allStrings = node.every((v) => typeof v === 'string');
      if (allStrings) {
        node.sort((a, b) =>
          (a as string).localeCompare(b as string, undefined, {
            sensitivity: 'variant',
            numeric: false,
          }),
        );
      }
    }
    return;
  }
  const seg = segments[idx]!;

  // `name[*]` segment: descend into the array at `name` and recurse into every
  // element, so the remaining path applies across all of them.
  const arrSpread = seg.match(/^([^[]+)\[\*\]$/);
  if (arrSpread) {
    const key = arrSpread[1]!;
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      const obj = node as Record<string, unknown>;
      const arr = obj[key];
      if (Array.isArray(arr)) {
        for (const elem of arr) {
          walkAndSort(elem, segments, idx + 1);
        }
      }
    }
    return;
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    walkAndSort(obj[seg], segments, idx + 1);
  }
}

/**
 * Walk the whole document and rewrite every *string* value by stripping each
 * compiled prefix from its front (see {@link applyStrip}). Recurses through
 * arrays and plain objects, mutating string leaves in place. Used to erase
 * machine-varying prefixes (e.g. absolute paths) so they do not cause spurious
 * golden drift. `compiled` is the prefix regexes pre-anchored with `^`.
 */
function stripPrefixesDeep(node: unknown, compiled: readonly RegExp[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') {
        node[i] = applyStrip(v, compiled);
      } else {
        stripPrefixesDeep(v, compiled);
      }
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        obj[k] = applyStrip(v, compiled);
      } else {
        stripPrefixesDeep(v, compiled);
      }
    }
  }
}

/**
 * Apply every compiled prefix regex to `s` in sequence, removing each match.
 * Each regex is `^`-anchored, so only a leading occurrence is stripped; passes
 * are cumulative so a string can have multiple prefixes peeled. Pure.
 */
function applyStrip(s: string, compiled: readonly RegExp[]): string {
  let out = s;
  for (const re of compiled) {
    out = out.replace(re, '');
  }
  return out;
}

/**
 * Build the three inputs {@link buildEvaluatorPlan} needs for one fixture from
 * the fixture's on-disk state.
 *
 * Resolves the fixture's config (`composeResolvedConfig`), then for each active
 * stack loads its body and projects the fields the core consumes (scope,
 * command hooks, security/documentation surfaces) into an
 * {@link EvaluatorCoreSnapshot}; merges the overlay's `evaluator.additionalChecks`
 * splice point; reads `sprint-plan.json`; and walks the worktree for the file
 * set. Each `read*` helper is defensive — unexpected shapes are dropped, not
 * thrown — so a malformed fixture yields a smaller plan that simply won't match
 * its golden, surfacing as drift rather than a crash. Async because config
 * resolution is async. Reads the filesystem; no writes.
 *
 * @param projectRoot the fixture directory.
 */
async function assembleInputsForFixture(projectRoot: string): Promise<{
  snapshot: EvaluatorCoreSnapshot;
  sprintPlan: SprintPlan;
  worktree: WorktreeState;
}> {
  const resolved = await composeResolvedConfig(projectRoot);

  const activeStacks: EvaluatorCoreSnapshot['activeStacks'] = [];
  for (const name of resolved.stacks.active) {
    const loaded = loadStack(name, projectRoot);
    const body = (loaded.data ?? {}) as Record<string, unknown>;
    const entry: EvaluatorCoreSnapshot['activeStacks'][number] = {
      name,
      scope: readStringArray(body['scope']),
    };
    const secretsGlob = readStringArray(body['secretsGlob']);
    if (secretsGlob.length > 0) entry.secretsGlob = secretsGlob;
    const auditCmd = readAuditCmd(body['auditCmd']);
    if (auditCmd) entry.auditCmd = auditCmd;

    const docLintCmd = readDocLintCmd(body['docLintCmd']);
    if (docLintCmd) entry.docLintCmd = docLintCmd;
    if (typeof body['buildCmd'] === 'string') entry.buildCmd = body['buildCmd'];
    if (typeof body['testCmd'] === 'string') entry.testCmd = body['testCmd'];
    if (typeof body['lintCmd'] === 'string') entry.lintCmd = body['lintCmd'];
    const surfaces = readSurfaces(body['securitySurfaces']);
    if (surfaces.length > 0) entry.securitySurfaces = surfaces;

    const docSurfaces = readSurfaces(body['documentationSurfaces']);
    if (docSurfaces.length > 0) entry.documentationSurfaces = docSurfaces;
    activeStacks.push(entry);
  }

  const additionalChecks = readAdditionalChecks(resolved.overlay);
  const snapshot: EvaluatorCoreSnapshot = {
    activeStacks,
    mergedSplicePoints:
      additionalChecks.length > 0 ? { 'evaluator.additionalChecks': additionalChecks } : {},
  };

  const sprintPlan = readSprintPlan(projectRoot);
  const worktree = enumerateWorktree(projectRoot, activeStacks);

  return { snapshot, sprintPlan, worktree };
}

// The read* helpers below all defensively narrow an `unknown` value parsed
// from a stack/overlay body into a typed shape the evaluator core accepts.
// They never throw: a missing or wrong-typed field is dropped (or defaulted),
// so a malformed fixture produces a smaller-but-valid plan that fails as golden
// drift rather than crashing the run.

/** Keep only the string elements of `v`; non-arrays become `[]`. */
function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Project a stack's `auditCmd` body into the core's shape, or `undefined` when
 * it is absent or lacks a string `command`. An unrecognised `absenceSignal`
 * defaults to `'silent'`; `absenceMessage` is carried only when a string.
 */
function readAuditCmd(v: unknown): EvaluatorCoreSnapshot['activeStacks'][number]['auditCmd'] {
  if (v === null || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj['command'] !== 'string') return undefined;
  const signal = obj['absenceSignal'];
  const validSignals = ['silent', 'warning', 'blockingConcern'] as const;
  const absenceSignal = (validSignals as readonly string[]).includes(signal as string)
    ? (signal as 'silent' | 'warning' | 'blockingConcern')
    : 'silent';
  const out: NonNullable<EvaluatorCoreSnapshot['activeStacks'][number]['auditCmd']> = {
    command: obj['command'],
    absenceSignal,
  };
  if (typeof obj['absenceMessage'] === 'string') out.absenceMessage = obj['absenceMessage'];
  return out;
}

/**
 * Project a stack's `docLintCmd` body into a {@link DocLintCmd}, or `undefined`
 * when absent or lacking a string `command`. Unrecognised `absenceSignal`
 * defaults to `'silent'` and unrecognised `severity` to `'blocker'`;
 * `absenceMessage` and `baseline` (`'delta'`/`'absolute'`) are carried only
 * when valid.
 */
function readDocLintCmd(v: unknown): DocLintCmd | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj['command'] !== 'string') return undefined;
  const signal = obj['absenceSignal'];
  const validSignals = ['silent', 'warning', 'blockingConcern'] as const;
  const absenceSignal = (validSignals as readonly string[]).includes(signal as string)
    ? (signal as 'silent' | 'warning' | 'blockingConcern')
    : 'silent';
  const sev = obj['severity'];
  const validSeverities = ['blocker', 'warning', 'advisory'] as const;

  const severity = (validSeverities as readonly string[]).includes(sev as string)
    ? (sev as 'blocker' | 'warning' | 'advisory')
    : 'blocker';
  const out: DocLintCmd = {
    command: obj['command'],
    absenceSignal,
    severity,
  };
  if (typeof obj['absenceMessage'] === 'string') out.absenceMessage = obj['absenceMessage'];

  const base = obj['baseline'];
  if (base === 'delta' || base === 'absolute') out.baseline = base;
  return out;
}

/**
 * Project an array of security/documentation surface descriptors into
 * {@link SecuritySurface}[]. Entries without both a string `id` and `template`
 * are skipped; an entry's optional `triggers` (`keywords`/`scope` string
 * arrays) is attached only when it contributes at least one non-empty list.
 * A non-array `v` yields `[]`.
 */
function readSurfaces(v: unknown): SecuritySurface[] {
  if (!Array.isArray(v)) return [];
  const out: SecuritySurface[] = [];
  for (const entry of v) {
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj['id'] !== 'string') continue;
    if (typeof obj['template'] !== 'string') continue;
    const surface: SecuritySurface = { id: obj['id'], template: obj['template'] };
    const triggers = obj['triggers'];
    if (triggers !== null && typeof triggers === 'object') {
      const trigObj = triggers as Record<string, unknown>;
      const t: NonNullable<SecuritySurface['triggers']> = {};
      const keywords = readStringArray(trigObj['keywords']);
      if (keywords.length > 0) t.keywords = keywords;
      const scope = readStringArray(trigObj['scope']);
      if (scope.length > 0) t.scope = scope;
      if (Object.keys(t).length > 0) surface.triggers = t;
    }
    out.push(surface);
  }
  return out;
}

/**
 * Extract the overlay's `evaluator.additionalChecks` splice point: each entry
 * with string `command`, `on_failure`, and `tier` becomes a check. Anything
 * else (missing/odd-typed evaluator block, non-array checks, malformed entry)
 * yields `[]`, so the splice point is omitted from the snapshot entirely.
 */
function readAdditionalChecks(
  overlay: Record<string, unknown>,
): NonNullable<EvaluatorCoreSnapshot['mergedSplicePoints']['evaluator.additionalChecks']> {
  const evaluator = overlay['evaluator'];
  if (evaluator === null || typeof evaluator !== 'object' || Array.isArray(evaluator)) return [];
  const checks = (evaluator as Record<string, unknown>)['additionalChecks'];
  if (!Array.isArray(checks)) return [];
  const out: NonNullable<
    EvaluatorCoreSnapshot['mergedSplicePoints']['evaluator.additionalChecks']
  > = [];
  for (const c of checks) {
    if (c === null || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    if (
      typeof obj['command'] === 'string' &&
      typeof obj['on_failure'] === 'string' &&
      typeof obj['tier'] === 'string'
    ) {
      out.push({
        command: obj['command'],
        on_failure: obj['on_failure'],
        tier: obj['tier'],
      });
    }
  }
  return out;
}

/**
 * Read and shape the fixture's `sprint-plan.json` into a {@link SprintPlan}.
 *
 * `readFileSync`/`JSON.parse` may throw and propagate (a fixture without a
 * readable sprint plan is a real setup error). The parsed body is then
 * defensively projected: `affectedFiles` keeps only strings, and `criteria`
 * keeps only entries with string `id` and `description`, dropping anything
 * malformed rather than failing.
 *
 * @param projectRoot the fixture directory containing `sprint-plan.json`.
 */
function readSprintPlan(projectRoot: string): SprintPlan {
  const planPath = path.join(projectRoot, 'sprint-plan.json');
  const raw = readFileSync(planPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<SprintPlan>;
  const affectedFiles = Array.isArray(parsed.affectedFiles)
    ? parsed.affectedFiles.filter((x): x is string => typeof x === 'string')
    : [];
  const criteria = Array.isArray(parsed.criteria)
    ? parsed.criteria
        .filter(
          (c): c is { id: string; description: string } =>
            c !== null &&
            typeof c === 'object' &&
            typeof (c as Record<string, unknown>)['id'] === 'string' &&
            typeof (c as Record<string, unknown>)['description'] === 'string',
        )
        .map((c) => ({ id: c.id, description: c.description }))
    : [];
  return { affectedFiles, criteria };
}

/**
 * Walk the fixture's worktree into a {@link WorktreeState}: the sorted list of
 * relative file paths, plus the contents of those files that fall within an
 * active stack's scope.
 *
 * An iterative (stack-based) directory walk avoids deep recursion; build/VCS/
 * cache dirs and the fixture's own harness files (the golden, the sprint plan)
 * are skipped so they never become evaluator input. Paths are normalised to
 * forward slashes and sorted, both for determinism. Only files matching some
 * active stack's glob scope have their content loaded — the rest just need to
 * exist in the listing — which keeps the snapshot small. Unreadable directories
 * and files are skipped silently. Reads disk only.
 *
 * @param projectRoot the fixture root to walk.
 * @param activeStacks the stacks whose scope globs decide which file contents
 *   are loaded.
 */
function enumerateWorktree(
  projectRoot: string,
  activeStacks: readonly EvaluatorCoreSnapshot['activeStacks'][number][],
): WorktreeState {
  const out: string[] = [];
  // Never descend into VCS/build/cache dirs — they are not part of the
  // evaluated source and would make the file set non-deterministic.
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.gan-state', '.gan-cache']);
  // Harness artefacts live alongside the fixture but must not be fed back in as
  // worktree input (the golden is the comparison target, not an input).
  const skipFiles = new Set(['expected-evaluator-plan.json', 'sprint-plan.json']);
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (skipDirs.has(name)) continue;
        stack.push(full);
      } else if (s.isFile()) {
        if (skipFiles.has(name)) continue;
        const rel = path.relative(projectRoot, full).split(path.sep).join('/');
        out.push(rel);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }));

  // Load contents only for files inside some active stack's scope: the core
  // does keyword analysis on those files, but the rest only need to appear in
  // the path listing, so reading them all would be wasted I/O.
  const fileContents: Record<string, string> = {};
  for (const file of out) {
    const inAnyScope = activeStacks.some((stk) =>
      stk.scope.some((pattern) => globMatchesPath(pattern, file)),
    );
    if (!inAnyScope) continue;
    try {
      fileContents[file] = readFileSync(path.join(projectRoot, file), 'utf8');
    } catch {
      // Skip unreadable files; the carve-out treats missing content as
      // "no keyword evidence available".
    }
  }
  return { files: out, fileContents };
}

// Compiling a picomatch matcher is comparatively expensive and the same scope
// patterns are tested against many files, so matchers are memoised per pattern
// for the lifetime of the process. The map is module-level (not per call)
// because the worktree walk reuses the same handful of stack globs throughout.
const _matcherCache = new Map<string, (p: string) => boolean>();

/**
 * Test whether `file` (a forward-slashed relative path) matches the glob
 * `pattern`, caching the compiled matcher in {@link _matcherCache}. `dot: true`
 * so dotfiles are matchable. Pure result; the only side effect is populating
 * the cache.
 */
function globMatchesPath(pattern: string, file: string): boolean {
  let matcher = _matcherCache.get(pattern);
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true });
    _matcherCache.set(pattern, matcher);
  }
  return matcher(file);
}

/**
 * Run the pipeline check across all known fixtures and render the result.
 *
 * Order of concerns: (1) the guard-rail veto — `allowGuardrailRemoval` under
 * `CI=1` is refused outright (`GuardrailRemovalRefusedUnderCI`); (2) presence
 * scan — each missing {@link KNOWN_FIXTURES} entry is a `GuardrailFixtureRemoved`
 * failure unless removal is allowed (then it is skipped); (3) for each present
 * fixture, assemble inputs, build the plan, normalise it, and either re-seed the
 * golden (`updateGoldens`) or diff against it (`EvaluatorPlanMissing` /
 * `EvaluatorPlanDrift`). A failure to read the normalise rules short-circuits
 * with `NormaliseRulesUnreadable`; a per-fixture assembly throw becomes an
 * `EvaluatorPlanComposeFailed` failure and the run continues.
 *
 * `checked` counts only present fixtures actually processed. Exit code is
 * `SUCCESS` with no failures, else `FAILURE`. Side effect: in `--update-goldens`
 * mode, writes each fixture's golden via `atomicWriteFile`; otherwise read-only.
 *
 * @param opts resolved {@link RunOptions}.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const failures: ReportFailure[] = [];

  // Guard-rail veto: the removal escape hatch is refused under CI before any
  // fixture work, so CI can never run with the multi-stack guard disarmed —
  // even accidentally. This is a hard stop, reported and returned immediately.
  if (opts.ci && opts.allowGuardrailRemoval) {
    const report: EvaluatorPipelineCheckReport = {
      kind: 'evaluator-pipeline-check',
      checked: 0,
      failures: [
        {
          path: '<harness>',
          code: 'GuardrailRemovalRefusedUnderCI',
          message:
            '--allow-guardrail-removal is refused under CI=1; the multi-stack ' +
            'guard rail must remain intact in CI. Restore any missing fixture ' +
            'or run the harness locally to re-seed the goldens.',
        },
      ],
    };
    return finishReport(report, opts);
  }

  const presentFixtures: string[] = [];
  const missingFixtures: string[] = [];
  for (const fixture of KNOWN_FIXTURES) {
    const dir = path.join(opts.fixtureRoot, fixture);
    try {
      const s = statSync(dir);
      if (s.isDirectory()) {
        presentFixtures.push(fixture);
      } else {
        missingFixtures.push(fixture);
      }
    } catch {
      missingFixtures.push(fixture);
    }
  }
  if (missingFixtures.length > 0 && !opts.allowGuardrailRemoval) {
    for (const fixture of missingFixtures) {
      failures.push({
        path: path.join(opts.fixtureRoot, fixture),
        code: 'GuardrailFixtureRemoved',
        message:
          `Bootstrap fixture '${fixture}' is missing on disk. Restore the fixture, ` +
          `or pass --allow-guardrail-removal to acknowledge the change explicitly.`,
      });
    }
    // If `allowGuardrailRemoval && !ci`, the missing fixtures are skipped.
  }

  // When a fixture is missing AND removal is not allowed, treat it as fatal:
  // skip the diff phase entirely (the run is already failing on a structural
  // problem, so diffing the survivors would only add noise).
  const fatalGuardrail = failures.length > 0 && !opts.allowGuardrailRemoval;
  const checked = presentFixtures.length;

  if (!fatalGuardrail) {
    let rules: NormaliseRules;
    try {
      rules = loadNormaliseRules(opts.normaliseRulesPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const report: EvaluatorPipelineCheckReport = {
        kind: 'evaluator-pipeline-check',
        checked: 0,
        failures: [
          {
            path: opts.normaliseRulesPath,
            code: 'NormaliseRulesUnreadable',
            message: `Could not read or parse the normalise-rules file: ${msg}.`,
          },
        ],
      };
      return finishReport(report, opts);
    }

    for (const fixture of presentFixtures) {
      const projectRoot = path.join(opts.fixtureRoot, fixture);
      const goldenPath = goldenPathFor(opts.fixtureRoot, fixture);

      let plan: EvaluatorPlan;
      try {
        const inputs = await assembleInputsForFixture(projectRoot);
        plan = buildEvaluatorPlan(inputs.snapshot, inputs.sprintPlan, inputs.worktree);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({
          path: projectRoot,
          code: 'EvaluatorPlanComposeFailed',
          message: `Could not assemble evaluator inputs for fixture '${fixture}': ${msg}.`,
        });
        continue;
      }

      // Normalise then canonically serialise: the same `serialised` bytes are
      // what both the golden write and the drift comparison use, so a re-seed
      // followed by a check is guaranteed to pass (idempotent goldens).
      const normalised = applyNormaliseRules(plan, rules);
      const serialised = stableStringify(normalised);

      if (opts.updateGoldens) {
        atomicWriteFile(goldenPath, serialised);
        continue;
      }

      const existing = readFileIfExists(goldenPath);
      if (existing === null) {
        failures.push({
          path: goldenPath,
          code: 'EvaluatorPlanMissing',
          message: `no expected-evaluator-plan.json — run with --update-goldens to seed; fixture: ${fixture}`,
        });
        continue;
      }
      if (existing !== serialised) {
        const truncated = serialised.slice(0, 200);
        failures.push({
          path: goldenPath,
          code: 'EvaluatorPlanDrift',
          message: `normalised output differs from golden; first 200 chars of actual: ${truncated}`,
        });
      }
    }
  }

  const report: EvaluatorPipelineCheckReport = {
    kind: 'evaluator-pipeline-check',
    checked,
    failures,
  };

  return finishReport(report, opts);
}

/**
 * Turn a finished report into a {@link RunResult}: render it (JSON vs. human),
 * suppress the clean-run stdout summary under `--quiet`, and derive the exit
 * code (`SUCCESS` iff no failures, else `FAILURE`). Pure. (Named `finishReport`
 * rather than `finalize` like the lint scripts, but plays the same role.)
 */
function finishReport(report: EvaluatorPipelineCheckReport, opts: RunOptions): RunResult {
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
 * CLI entrypoint: parse argv, derive the CI flag, dispatch to {@link run}, and
 * write its output.
 *
 * Returns the exit code rather than calling `process.exit`, so it is testable
 * in-process. `--help` short-circuits with `SUCCESS`; an unknown flag or
 * unexpected positional returns `BAD_ARGS` before any fixture work. The `ci`
 * option is read from the `CI` env var (`=== '1'`) rather than a flag, since it
 * is set by the CI environment, not the caller; `--project-root` is accepted
 * for parser uniformity and ignored. Side effect: writing stdout/stderr (plus
 * golden writes inside `run` when `--update-goldens` is set).
 *
 * @param argv argument tokens, typically `process.argv.slice(2)`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['json', 'quiet', 'help', 'update-goldens', 'allow-guardrail-removal'],
    string: ['fixture-root', 'normalise-rules', 'project-root'],
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
  const normaliseRulesPath =
    typeof parsed.flags['normalise-rules'] === 'string'
      ? (parsed.flags['normalise-rules'] as string)
      : defaultNormaliseRules;

  // CI presence comes from the environment, not a flag, so the guard-rail veto
  // in `run` keys off the actual CI setting and cannot be spoofed via argv.
  const ci = process.env['CI'] === '1';

  const result = await run({
    fixtureRoot,
    normaliseRulesPath,
    updateGoldens: parsed.flags['update-goldens'] === true,
    allowGuardrailRemoval: parsed.flags['allow-guardrail-removal'] === true,
    ci,
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
    process.stderr.write(`evaluator-pipeline-check: fatal: ${msg}\n`);
    process.exit(SCRIPT_EXIT.FAILURE);
  },
);

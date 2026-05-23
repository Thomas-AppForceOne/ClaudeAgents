#!/usr/bin/env node

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

const KNOWN_FIXTURES = [
  'generic-fallback',
  'js-ts-minimal',
  'node-packaged-non-web',
  'polyglot-webnode-synthetic',
  'synthetic-second',
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '..', '..', '..');
const defaultFixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const defaultNormaliseRules = path.join(repoRoot, 'tests', 'fixtures', 'normalise-rules.json');

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

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {

  fixtureRoot: string;

  normaliseRulesPath: string;

  updateGoldens: boolean;

  allowGuardrailRemoval: boolean;

  ci: boolean;

  json: boolean;

  quiet: boolean;
}

function goldenPathFor(fixtureRoot: string, fixture: string): string {
  return path.join(fixtureRoot, fixture, 'expected-evaluator-plan.json');
}

function readFileIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

interface NormaliseRules {
  sortArrays: Array<{ path: string; by: string | string[] }>;
  sortInPlace: string[];
  stripPrefixes: string[];
}

function loadNormaliseRules(rulesPath: string): NormaliseRules {
  const raw = readFileSync(rulesPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<NormaliseRules>;
  return {
    sortArrays: Array.isArray(parsed.sortArrays) ? parsed.sortArrays : [],
    sortInPlace: Array.isArray(parsed.sortInPlace) ? parsed.sortInPlace : [],
    stripPrefixes: Array.isArray(parsed.stripPrefixes) ? parsed.stripPrefixes : [],
  };
}

function applyNormaliseRules(plan: EvaluatorPlan, rules: NormaliseRules): EvaluatorPlan {

  const cloned = JSON.parse(JSON.stringify(plan)) as EvaluatorPlan;

  for (const rule of rules.sortArrays) {
    const arr = (cloned as unknown as Record<string, unknown>)[rule.path];
    if (!Array.isArray(arr)) continue;
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

function sortInPlaceByPath(root: unknown, dottedPath: string): void {
  const segments = dottedPath.split('.');
  walkAndSort(root, segments, 0);
}

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

function applyStrip(s: string, compiled: readonly RegExp[]): string {
  let out = s;
  for (const re of compiled) {
    out = out.replace(re, '');
  }
  return out;
}

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

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

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

function enumerateWorktree(
  projectRoot: string,
  activeStacks: readonly EvaluatorCoreSnapshot['activeStacks'][number][],
): WorktreeState {
  const out: string[] = [];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.gan-state', '.gan-cache']);
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

const _matcherCache = new Map<string, (p: string) => boolean>();
function globMatchesPath(pattern: string, file: string): boolean {
  let matcher = _matcherCache.get(pattern);
  if (!matcher) {
    matcher = picomatch(pattern, { dot: true });
    _matcherCache.set(pattern, matcher);
  }
  return matcher(file);
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const failures: ReportFailure[] = [];

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

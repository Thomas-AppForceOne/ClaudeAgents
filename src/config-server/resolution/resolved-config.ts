

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort, stableStringify } from '../determinism/index.js';
import { loadOverlay } from '../storage/overlay-loader.js';
import { loadModuleConfig } from '../storage/module-config-loader.js';
import { parseYamlBlock } from '../storage/yaml-block-parser.js';
import { _runPhase1ForTests, validateAll, type Issue } from '../tools/validate.js';
import { cascadeOverlays } from './cascade.js';
import { detectActiveStacks } from './detection.js';
import {
  getResolvedConfigCache,
  cacheKeyForProjectRoot,
  backingFileMtime,
} from './cache.js';
import { resolveStackFile, type ResolveStackOptions } from './stack-resolution.js';

export interface ResolvedModuleEntry {
  name: string;
  manifestPath: string;
  pairsWith?: string;

  [extra: string]: unknown;
}

export interface ResolvedConfig {
  apiVersion: string;
  schemaVersions: { stack: number; overlay: number };

  runtimeMode: { noProjectCommands: boolean };
  stacks: {

    active: string[];

    byName: Record<string, ResolvedStackEntry>;
  };

  overlay: Record<string, unknown>;

  discarded: string[];

  additionalContext: {
    planner: AdditionalContextRow[];
    proposer: AdditionalContextRow[];
  };

  issues: Issue[];

  modules: Record<string, ResolvedModuleEntry>;
}

export interface ResolvedStackEntry {

  tier: 'project' | 'user' | 'builtin';

  path: string;

  schemaVersion: number;
}

export interface AdditionalContextRow {
  path: string;
  exists: boolean;
}

export interface ComposeContext {
  userHome?: string;
  apiVersion?: string;

  packageRoot?: string;

  noProjectCommands?: boolean;

  modulesRoot?: string;
}

const SCHEMA_VERSIONS = { stack: 1, overlay: 1 } as const;

export async function composeResolvedConfig(
  projectRoot: string,
  ctx: ComposeContext = {},
): Promise<ResolvedConfig> {
  const apiVersion = ctx.apiVersion ?? (await readApiVersion());
  return composeResolvedConfigSync(projectRoot, apiVersion, ctx);
}

export function composeResolvedConfigSync(
  projectRoot: string,
  apiVersion: string,
  ctx: ComposeContext = {},
): ResolvedConfig {
  const canonRoot = cacheKeyForProjectRoot(projectRoot);
  const cache = getResolvedConfigCache<ResolvedConfig>();
  const cached = cache.get(canonRoot);
  if (cached !== undefined) return cached;

  const validation = validateAll(
    { projectRoot: canonRoot },
    {
      ...(ctx.userHome ? { userHome: ctx.userHome } : {}),
      ...(ctx.packageRoot ? { packageRoot: ctx.packageRoot } : {}),
      ...(ctx.modulesRoot ? { modulesRoot: ctx.modulesRoot } : {}),
    },
  );
  const allIssues: Issue[] = [...validation.issues];

  const snapshot = _runPhase1ForTests(canonRoot, {
    ...(ctx.userHome ? { userHome: ctx.userHome } : {}),
    ...(ctx.packageRoot ? { packageRoot: ctx.packageRoot } : {}),
    ...(ctx.modulesRoot ? { modulesRoot: ctx.modulesRoot } : {}),
  });
  for (const row of snapshot.stackFiles.values()) {
    if (row.data !== undefined) continue;
    try {
      if (!existsSync(row.path)) continue;
      const text = readFileSync(row.path, 'utf8');
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // Parse failures already turn into Issues during validateAll's
      // phase 2; ignore here so detection is best-effort.
    }
  }

  const overlayLoadOpts = ctx.userHome ? { userHome: ctx.userHome } : {};
  const def = loadOverlay('default', canonRoot, overlayLoadOpts);
  const user = loadOverlay('user', canonRoot, overlayLoadOpts);
  const proj = loadOverlay('project', canonRoot, overlayLoadOpts);
  const cascade = cascadeOverlays({
    default: def?.data ?? null,
    user: user?.data ?? null,
    project: proj?.data ?? null,
  });
  for (const issue of cascade.issues) allIssues.push(issue);

  const stackOverride = readStackOverride(cascade.merged);
  const detection = detectActiveStacks(snapshot, { stackOverride });
  for (const issue of detection.issues) allIssues.push(issue);

  const byName: Record<string, ResolvedStackEntry> = {};
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
  for (const name of detection.active) {
    try {
      const r = resolveStackFile(name, canonRoot, opts);
      byName[name] = {
        tier: r.tier,
        path: r.path,
        schemaVersion: SCHEMA_VERSIONS.stack,
      };
    } catch {
      // The detection layer already raised MissingFile; skip to avoid
      // double-reporting.
    }
  }

  const additionalContext = {
    planner: extractAdditionalContextRows(cascade.merged, 'planner', canonRoot),
    proposer: extractAdditionalContextRows(cascade.merged, 'proposer', canonRoot),
  };

  const sortedIssues = sortIssues(allIssues);

  const modules: Record<string, ResolvedModuleEntry> = {};
  for (const m of snapshot.modules) {
    const entry: ResolvedModuleEntry = { name: m.name, manifestPath: m.manifestPath };
    if (typeof m.pairsWith === 'string') entry.pairsWith = m.pairsWith;
    const cfg = loadModuleConfig(canonRoot, m.name);
    if (cfg !== null && isObject(cfg)) {
      for (const k of Object.keys(cfg)) {

        if (k === 'name' || k === 'manifestPath' || k === 'pairsWith') continue;
        entry[k] = cfg[k];
      }
    }
    modules[m.name] = entry;
  }

  const resolved: ResolvedConfig = {
    apiVersion,
    schemaVersions: { ...SCHEMA_VERSIONS },
    runtimeMode: { noProjectCommands: ctx.noProjectCommands ?? false },
    stacks: {
      active: detection.active.slice(),
      byName,
    },
    overlay: cascade.merged,
    discarded: cascade.discarded.slice(),
    additionalContext,
    issues: sortedIssues,
    modules,
  };

  const canonical = JSON.parse(stableStringify(resolved)) as ResolvedConfig;

  const backingFileStates = collectBackingFileStates({
    canonRoot,
    userHome: ctx.userHome,
    activeStackNames: detection.active.slice(),
    activeStackPaths: Object.values(byName).map((entry) => entry.path),
    moduleNames: snapshot.modules.map((m) => m.name),
  });
  cache.set(canonRoot, canonical, backingFileStates);
  return canonical;
}

function collectBackingFileStates(input: {
  canonRoot: string;
  userHome: string | undefined;
  activeStackNames: string[];
  activeStackPaths: string[];
  moduleNames: string[];
}): Map<string, number | null> {
  const states = new Map<string, number | null>();

  const userHome =
    input.userHome ??
    process.env['GAN_USER_HOME'] ??
    process.env['HOME'] ??
    process.env['USERPROFILE'];
  const hasUserHome = typeof userHome === 'string' && userHome.length > 0;

  states.set(
    path.join(input.canonRoot, '.claude', 'gan', 'default.md'),
    null,
  );
  states.set(
    path.join(input.canonRoot, '.claude', 'gan', 'project.md'),
    null,
  );
  if (hasUserHome) {
    states.set(path.join(userHome, '.claude', 'gan', 'user.md'), null);
  }

  for (const p of input.activeStackPaths) states.set(p, null);

  for (const name of input.activeStackNames) {
    states.set(path.join(input.canonRoot, '.claude', 'gan', 'stacks', `${name}.md`), null);
    if (hasUserHome) {
      states.set(path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`), null);
    }
  }

  for (const name of input.moduleNames) {
    states.set(path.join(input.canonRoot, '.claude', 'gan', 'modules', `${name}.yaml`), null);
  }

  for (const p of states.keys()) {
    states.set(p, backingFileMtime(p));
  }
  return states;
}

function readStackOverride(merged: Record<string, unknown>): string[] | undefined {
  if (!isObject(merged)) return undefined;
  const stack = merged['stack'];
  if (!isObject(stack)) return undefined;
  const ov = stack['override'];
  if (Array.isArray(ov)) {
    return ov.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

function extractAdditionalContextRows(
  merged: Record<string, unknown>,
  block: 'planner' | 'proposer',
  projectRoot: string,
): AdditionalContextRow[] {
  const blockData = merged[block];
  if (!isObject(blockData)) return [];
  const ac = blockData['additionalContext'];
  if (!Array.isArray(ac)) return [];
  const rows: AdditionalContextRow[] = [];
  for (const entry of ac) {
    if (typeof entry !== 'string') continue;
    const absolute = path.isAbsolute(entry) ? entry : path.join(projectRoot, entry);
    let exists = false;
    try {
      if (existsSync(absolute)) {
        const s = statSync(absolute);
        exists = s.isFile();
      }
    } catch {
      exists = false;
    }
    rows.push({ path: entry, exists });
  }

  const byPath = new Map<string, AdditionalContextRow>();
  for (const r of rows) byPath.set(r.path, r);
  return localeSort(Array.from(byPath.keys())).map((k) => byPath.get(k) as AdditionalContextRow);
}

function sortIssues(issues: Issue[]): Issue[] {
  const SEP = '';
  const keyed = issues.map((issue, idx) => ({
    issue,
    key: `${issue.code}${SEP}${issue.path ?? ''}${SEP}${issue.field ?? ''}${SEP}${issue.message}${SEP}${idx}`,
  }));
  const byKey = new Map<string, Issue>();
  for (const k of keyed) byKey.set(k.key, k.issue);
  return localeSort(Array.from(byKey.keys())).map((k) => byKey.get(k) as Issue);
}

async function readApiVersion(): Promise<string> {
  const mod = await import('../index.js');
  const meta = await mod.readPackageMeta();
  return meta.version;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export { canonicalizePath, localeSort };

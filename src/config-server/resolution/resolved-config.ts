/**
 * Top of the config-resolution pipeline: compose the single, fully-resolved
 * config object the rest of the `/gan` loop reads.
 *
 * This orchestrates the lower layers in order — validate everything, snapshot
 * stack files, cascade the overlay tiers, detect active stacks, resolve each
 * to a concrete file, gather module config, and collect issues — then freezes
 * the result into a deterministic, canonical form.
 *
 * Two guarantees hold throughout:
 * 1. Determinism: the returned object is round-tripped through
 *    {@link stableStringify} so key order is canonical and byte-stable; all
 *    lists are sorted via {@link localeSort}.
 * 2. Cached + self-invalidating: the result is memoised in the shared
 *    resolved-config cache, tagged with the mtimes of every file it depends on
 *    (overlays, active stacks at every tier, module configs), so a later edit
 *    to any of them transparently busts the cache.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort, stableStringify } from '../determinism/index.js';
import { loadOverlay } from '../storage/overlay-loader.js';
import { loadModuleConfig } from '../storage/module-config-loader.js';
import { parseYamlBlock } from '../storage/yaml-block-parser.js';
import { _runPhase1ForTests, validateAll, type Issue } from '../tools/validate.js';
import { cascadeOverlays } from './cascade.js';
import { detectActiveStacks } from './detection.js';
import type { Warning } from '../warnings.js';
import { getResolvedConfigCache, cacheKeyForProjectRoot, backingFileMtime } from './cache.js';
import { resolveStackFile, type ResolveStackOptions } from './stack-resolution.js';

/**
 * A resolved module's entry in {@link ResolvedConfig.modules}.
 *
 * @property name the module's unique name.
 * @property manifestPath absolute path of the module's manifest.
 * @property pairsWith optional name of a module this one is paired with.
 * @property [extra] the module's own resolved config fields are spread in via
 *   the index signature, except the three reserved keys above (which the
 *   manifest cannot shadow).
 */
export interface ResolvedModuleEntry {
  name: string;
  manifestPath: string;
  pairsWith?: string;

  [extra: string]: unknown;
}

/**
 * The fully-resolved configuration for a project — the single source the loop
 * consumes.
 *
 * @property apiVersion the config-server package version this was resolved by.
 * @property schemaVersions the schema versions in force for stacks/overlays.
 * @property runtimeMode runtime flags (currently just `noProjectCommands`).
 * @property stacks active stack names plus a per-name resolution
 *   ({@link ResolvedStackEntry}).
 * @property overlay the merged overlay (the cascade's `merged` output).
 * @property discarded dotted field names truncated by `discardInherited`.
 * @property additionalContext planner/proposer context-file rows
 *   ({@link AdditionalContextRow}), with existence resolved.
 * @property issues every problem found across all phases, de-duplicated and
 *   stably sorted. A non-empty `issues` does NOT prevent a config being
 *   returned — callers inspect it to decide whether to proceed.
 * @property warnings non-aborting warnings about overlay declarations the
 *   framework accepted but did not act on as the user likely intended (e.g. a
 *   `stack.override` that silently shrank the active set, or a per-stack command
 *   override that is recorded but not yet applied). Always present — an empty
 *   array when none apply — so downstream surfaces never branch on absence.
 *   Unlike `issues`, warnings never prevent a run; they are informational.
 * @property modules resolved module entries keyed by module name.
 */
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

  warnings: Warning[];

  modules: Record<string, ResolvedModuleEntry>;
}

/**
 * Where an active stack resolved to.
 *
 * @property tier which tier won (project > user > builtin).
 * @property path absolute path of the winning stack file.
 * @property schemaVersion the stack schema version (pinned to the framework's).
 */
export interface ResolvedStackEntry {
  tier: 'project' | 'user' | 'builtin';

  path: string;

  schemaVersion: number;
}

/**
 * One additional-context entry resolved against the filesystem.
 *
 * @property path the path as declared in the overlay (kept as-declared for
 *   display, not canonicalised).
 * @property exists whether that path resolves to an existing *file* now.
 */
export interface AdditionalContextRow {
  path: string;
  exists: boolean;
}

/**
 * Optional inputs/overrides for composition; the production default `{}`
 * derives everything from env and package layout.
 *
 * @property userHome user home for overlay/stack user-tier resolution.
 * @property apiVersion pin the reported API version (else read from the
 *   package); the async {@link composeResolvedConfig} fills this in.
 * @property packageRoot installed-package root for built-in stack resolution.
 * @property noProjectCommands sets `runtimeMode.noProjectCommands`.
 * @property modulesRoot override for where modules are discovered.
 */
export interface ComposeContext {
  userHome?: string;
  apiVersion?: string;

  packageRoot?: string;

  noProjectCommands?: boolean;

  modulesRoot?: string;
}

// The schema versions this build of the framework speaks. Frozen as the single
// source for the versions stamped into every resolved config.
const SCHEMA_VERSIONS = { stack: 1, overlay: 1 } as const;

/**
 * Async entry point: resolve `apiVersion` (from `ctx` or the package
 * `package.json`) and delegate to {@link composeResolvedConfigSync}.
 *
 * @param projectRoot the project to resolve config for (any spelling;
 *   canonicalised inside).
 * @param ctx see {@link ComposeContext}.
 * @returns the resolved config (cached on subsequent calls).
 */
export async function composeResolvedConfig(
  projectRoot: string,
  ctx: ComposeContext = {},
): Promise<ResolvedConfig> {
  const apiVersion = ctx.apiVersion ?? (await readApiVersion());
  return composeResolvedConfigSync(projectRoot, apiVersion, ctx);
}

/**
 * Synchronous core of resolution. Returns a cached value when one is still
 * fresh; otherwise runs the full pipeline and caches the result.
 *
 * @param projectRoot the project; canonicalised to the cache key internally.
 * @param apiVersion the API version to stamp (the async wrapper supplies it).
 * @param ctx see {@link ComposeContext}.
 * @returns the {@link ResolvedConfig}. Does not throw on config problems —
 *   those are collected into `issues`; only genuinely unexpected I/O faults
 *   (outside the per-step try/catch) would propagate.
 */
export function composeResolvedConfigSync(
  projectRoot: string,
  apiVersion: string,
  ctx: ComposeContext = {},
): ResolvedConfig {
  const canonRoot = cacheKeyForProjectRoot(projectRoot);
  const cache = getResolvedConfigCache<ResolvedConfig>();
  // Fast path: a still-fresh cached value (the cache self-evicts if any backing
  // file changed) avoids re-running the whole pipeline.
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

  // Build the phase-1 snapshot (stack/module discovery). Despite the test-only
  // name, this is the production discovery pass; detection consumes its rows.
  const snapshot = _runPhase1ForTests(canonRoot, {
    ...(ctx.userHome ? { userHome: ctx.userHome } : {}),
    ...(ctx.packageRoot ? { packageRoot: ctx.packageRoot } : {}),
    ...(ctx.modulesRoot ? { modulesRoot: ctx.modulesRoot } : {}),
  });
  // Ensure each stack row has its parsed body: phase 1 may leave `data`
  // unpopulated, and detection needs the parsed `detection` block. Parse the
  // remaining rows here on a best-effort basis.
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

  // Detection consumes the cascaded `stack.override` (if any) to choose between
  // explicit and auto-detection modes.
  const stackOverride = readStackOverride(cascade.merged);
  const detection = detectActiveStacks(snapshot, { stackOverride });
  for (const issue of detection.issues) allIssues.push(issue);

  // Non-aborting overlay warnings are computed once, by `validateAll`, and
  // carried onto the snapshot here. Reusing that single result (rather than
  // recomputing) keeps the warnings the resolved config exposes byte-identical
  // to what the validation surface reports for the same project — a single
  // source of truth for the two callers.
  const warnings: Warning[] = validation.warnings;

  // Resolve each active stack name to its winning file/tier.
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

  // Assemble each module's resolved entry: identity from the snapshot, plus the
  // module's own config spread in.
  const modules: Record<string, ResolvedModuleEntry> = {};
  for (const m of snapshot.modules) {
    const entry: ResolvedModuleEntry = { name: m.name, manifestPath: m.manifestPath };
    if (typeof m.pairsWith === 'string') entry.pairsWith = m.pairsWith;
    const cfg = loadModuleConfig(canonRoot, m.name);
    if (cfg !== null && isObject(cfg)) {
      for (const k of Object.keys(cfg)) {
        // Reserved identity keys are owned by the snapshot; a module's own
        // config must not shadow them, so skip those keys when spreading.
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
    warnings,
    modules,
  };

  // Freeze to the canonical form: serialise with sorted keys then re-parse, so
  // the cached/returned object has deterministic, byte-stable key ordering
  // regardless of the order fields were assembled above.
  const canonical = JSON.parse(stableStringify(resolved)) as ResolvedConfig;

  // Tag the cache entry with the mtimes of every file this result depends on,
  // so any later edit to an overlay, an active stack (at any tier), or a module
  // config transparently invalidates the entry on the next read.
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

// Build the file→mtime snapshot the cache uses to detect staleness. It records
// the overlay files at every tier, every active stack at both project and user
// tiers (not just the winning one — a NEW higher-tier file appearing must
// invalidate, even though it was absent at resolution time), and each module's
// config file. Paths are seeded to `null` then filled with their current
// mtime; a path that did not exist stays `null`, and its later appearance reads
// as a change.
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

  states.set(path.join(input.canonRoot, '.claude', 'gan', 'default.md'), null);
  states.set(path.join(input.canonRoot, '.claude', 'gan', 'project.md'), null);
  if (hasUserHome) {
    states.set(path.join(userHome, '.claude', 'gan', 'user.md'), null);
  }

  for (const p of input.activeStackPaths) states.set(p, null);

  // Track each active stack at BOTH project and user tiers, not just where it
  // resolved from: if a higher-precedence file is later created, that new file
  // changes resolution and must bust the cache even though it was absent now.
  for (const name of input.activeStackNames) {
    states.set(path.join(input.canonRoot, '.claude', 'gan', 'stacks', `${name}.md`), null);
    if (hasUserHome) {
      states.set(path.join(userHome, '.claude', 'gan', 'stacks', `${name}.md`), null);
    }
  }

  for (const name of input.moduleNames) {
    states.set(path.join(input.canonRoot, '.claude', 'gan', 'modules', `${name}.yaml`), null);
  }

  // Second pass: replace the seeded `null`s with each file's actual mtime
  // (still `null` for files that do not exist).
  for (const p of states.keys()) {
    states.set(p, backingFileMtime(p));
  }
  return states;
}

// Extract the cascaded `stack.override` list (string entries only) from the
// merged overlay, or undefined when absent — which keeps detection in
// auto-detection mode. Non-string entries are filtered out defensively.
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

// Build the planner/proposer additionalContext rows for one block: read the
// declared paths, resolve each (relative to the project root unless absolute),
// and record whether it currently points at an existing file. Paths are
// de-duplicated (keeping the last occurrence) and locale-sorted so the output
// is stable. `path` is kept as-declared for display, not canonicalised.
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

// Stably order issues for deterministic output. Each issue gets a composite
// key (code, path, field, message, original index) joined by a control-char
// separator that cannot occur in the fields; the trailing index keeps
// otherwise-identical issues distinct so none is lost in the Map-based de-dup,
// while locale-sorting the keys gives a reproducible order.
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

// Read the API version from the package metadata. Done via a dynamic import of
// `../index.js` to avoid a static import cycle (index.ts imports this module).
async function readApiVersion(): Promise<string> {
  const mod = await import('../index.js');
  const meta = await mod.readPackageMeta();
  return meta.version;
}

// Local plain-object guard: true only for a non-null, non-array object.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Convenience re-exports so consumers of resolved-config can reach these
// determinism primitives without importing the determinism module directly.
export { canonicalizePath, localeSort };

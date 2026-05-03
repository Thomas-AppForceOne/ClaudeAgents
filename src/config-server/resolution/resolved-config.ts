/**
 * R1 sprint 5 — `composeResolvedConfig`: full F2 stable-shape JSON.
 *
 * Pulls together everything S2–S5 has built:
 *   1. Run `validateAll` (so the snapshot's stackFiles/overlays carry
 *      parsed data and any phase 1–3 issues are accumulated).
 *   2. Cascade the three overlay tiers (C4) into a merged view.
 *   3. Run detection (C2) using the cascaded `stack.override`.
 *   4. Materialise the F2 stable shape — keys sorted at every depth via
 *      `determinism.stableStringify` for any serialised output.
 *
 * Idempotency: two consecutive calls return byte-identical JSON. We
 * achieve this by:
 *   - Sorting every collection that the call produces (active set,
 *     discarded list, additionalContext path-resolution rows, issues
 *     list).
 *   - Round-tripping the entire payload through
 *     `JSON.parse(stableStringify(...))` before returning, which sorts
 *     keys at every depth without re-running anything stateful.
 *
 * The result is cached per canonical project root (`cache.ts` singleton);
 * callers receive the cached value on subsequent calls until either an
 * explicit `invalidate(projectRoot)` happens (S6's writes will wire that)
 * or the server process restarts.
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
import { getResolvedConfigCache, cacheKeyForProjectRoot } from './cache.js';
import { resolveStackFile, type ResolveStackOptions } from './stack-resolution.js';

/**
 * One value in `ResolvedConfig.modules`, keyed by module name. Carries
 * the registration meta from `ValidationSnapshot.modules[i]` (`name`,
 * `manifestPath`, optional `pairsWith`) AND, when the project has
 * authored a per-module config YAML at
 * `<projectRoot>/.claude/gan/modules/<name>.yaml`, the parsed YAML
 * fields are spread directly into the same row so that
 * `getResolvedConfig().modules.<name>.<configField>` works as the M2
 * spec body documents.
 *
 * The keying-by-name (object, not array) is M2's design: M1 originally
 * carried this surface as an array, but M2's per-module config is
 * accessed via `.modules.<name>` and a record-shaped surface composes
 * cleanly without the post-M1 callers having to do `arr.find(...)`.
 */
export interface ResolvedModuleEntry {
  name: string;
  manifestPath: string;
  pairsWith?: string;
  // Per-module YAML fields are spread directly onto this row. We do
  // not enumerate them statically (each module's schema differs); the
  // index signature carries them.
  [extra: string]: unknown;
}

/** Stable F2-shape resolved config. */
export interface ResolvedConfig {
  apiVersion: string;
  schemaVersions: { stack: number; overlay: number };
  /**
   * Runtime knobs that affect how downstream agents *use* the resolved
   * config (rather than how the framework computed it). R5 S3
   * introduces `noProjectCommands`: when `true`, agents must skip
   * project-declared commands (per F4's `--no-project-commands`
   * runtime knob). The value is supplied by the caller via
   * `ComposeContext.noProjectCommands`; it is *not* read from any env
   * var here — the caller is responsible for surfacing the user's
   * choice.
   */
  runtimeMode: { noProjectCommands: boolean };
  stacks: {
    /** Sorted active stack names. */
    active: string[];
    /** Per-stack metadata, keyed by stack name. */
    byName: Record<string, ResolvedStackEntry>;
  };
  /** Cascaded overlay (the merged view). */
  overlay: Record<string, unknown>;
  /** `<block>.<field>` paths whose upstream contribution was discarded. */
  discarded: string[];
  /**
   * Path-resolution status for `additionalContext` entries. Keyed by
   * agent block (`planner`, `proposer`); each value is a list of
   * `{path, exists}` rows.
   */
  additionalContext: {
    planner: AdditionalContextRow[];
    proposer: AdditionalContextRow[];
  };
  /** Sorted issue list (validation + cascade + detection). */
  issues: Issue[];
  /**
   * Registered modules. Keyed by module name; each value is a
   * `ResolvedModuleEntry` carrying both registration meta (`name`,
   * `manifestPath`, optional `pairsWith`) and any per-module config
   * fields parsed from `<projectRoot>/.claude/gan/modules/<name>.yaml`.
   * Empty object when no modules ship on disk yet.
   */
  modules: Record<string, ResolvedModuleEntry>;
}

export interface ResolvedStackEntry {
  /** Tier the resolved stack file came from. */
  tier: 'project' | 'user' | 'builtin';
  /** Absolute path to the resolved stack file. */
  path: string;
  /** Stack body schemaVersion (per F3). */
  schemaVersion: number;
}

export interface AdditionalContextRow {
  path: string;
  exists: boolean;
}

/** Optional dependency injection for tests. */
export interface ComposeContext {
  userHome?: string;
  apiVersion?: string;
  /**
   * Override for the package root used by the C5 resolver's primary
   * built-in tier. When unset, the resolver calls `packageRoot()`
   * itself; tests inject a `mkdtempSync` directory.
   */
  packageRoot?: string;
  /**
   * Surface F4's `--no-project-commands` runtime knob into the
   * resolved view. Callers (CLI / MCP) translate the user's choice
   * into this boolean; the resolution layer only mirrors it onto
   * `runtimeMode.noProjectCommands`. Defaults to `false`.
   */
  noProjectCommands?: boolean;
  /**
   * Override the modules root used for M1 module discovery. Tests
   * inject a fixture path so the resolved view's `modules` rows are
   * hermetic. Production callers leave this unset.
   */
  modulesRoot?: string;
}

const SCHEMA_VERSIONS = { stack: 1, overlay: 1 } as const;

/**
 * Build the full F2 resolved-config JSON for a project root. Cached on
 * first call; subsequent calls return the same byte-identical JSON until
 * `invalidate(projectRoot)` is called.
 */
export async function composeResolvedConfig(
  projectRoot: string,
  ctx: ComposeContext = {},
): Promise<ResolvedConfig> {
  const apiVersion = ctx.apiVersion ?? (await readApiVersion());
  return composeResolvedConfigSync(projectRoot, apiVersion, ctx);
}

/**
 * Synchronous compose. Used by the public `getResolvedConfig` path once
 * `apiVersion` is known. Splitting async/sync lets tests build the full
 * shape without depending on `node:fs/promises` and lets the production
 * path keep `getResolvedConfig` async-only (it must read package.json).
 */
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

  // Re-build the snapshot to access parsed stack bodies for detection.
  // The cost is bounded (a few file reads); the alternative would be
  // exposing a snapshot accessor on `validateAll`, which would leak phase
  // internals.
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

  // Cascade the three overlay tiers.
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

  // Run detection using the cascaded `stack.override`.
  const stackOverride = readStackOverride(cascade.merged);
  const detection = detectActiveStacks(snapshot, { stackOverride });
  for (const issue of detection.issues) allIssues.push(issue);

  // Build per-stack metadata for every active stack via C5's resolver.
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

  // Path-resolution status for additionalContext.
  const additionalContext = {
    planner: extractAdditionalContextRows(cascade.merged, 'planner', canonRoot),
    proposer: extractAdditionalContextRows(cascade.merged, 'proposer', canonRoot),
  };

  const sortedIssues = sortIssues(allIssues);

  // Modules surface. Keyed by module name. Each entry carries the
  // snapshot's registration meta AND, when the project has authored a
  // per-module YAML at `<projectRoot>/.claude/gan/modules/<name>.yaml`,
  // the parsed YAML fields spread directly onto the entry so
  // `getResolvedConfig().modules.<name>.<configField>` works.
  const modules: Record<string, ResolvedModuleEntry> = {};
  for (const m of snapshot.modules) {
    const entry: ResolvedModuleEntry = { name: m.name, manifestPath: m.manifestPath };
    if (typeof m.pairsWith === 'string') entry.pairsWith = m.pairsWith;
    const cfg = loadModuleConfig(canonRoot, m.name);
    if (cfg !== null && isObject(cfg)) {
      for (const k of Object.keys(cfg)) {
        // Don't let the config silently overwrite the registration
        // meta — those keys are reserved.
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

  // Round-trip through stableStringify so every nested key order is
  // canonicalised.
  const canonical = JSON.parse(stableStringify(resolved)) as ResolvedConfig;
  cache.set(canonRoot, canonical);
  return canonical;
}

// ---- helpers --------------------------------------------------------------

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
  // Sort by path so the row order is deterministic. Re-build via the
  // determinism-pinned `localeSort` over the path strings, then map back
  // to row objects.
  const byPath = new Map<string, AdditionalContextRow>();
  for (const r of rows) byPath.set(r.path, r);
  return localeSort(Array.from(byPath.keys())).map((k) => byPath.get(k) as AdditionalContextRow);
}

/**
 * Sort issues by `(code, path, field, message)`. Implemented by
 * building a composite sort key per issue and sorting those keys via the
 * F3-pinned `localeSort`. Avoids a raw sort call with a custom
 * comparator and centralises the locale rule.
 */
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

// Re-exports for test consumers.
export { canonicalizePath, localeSort };

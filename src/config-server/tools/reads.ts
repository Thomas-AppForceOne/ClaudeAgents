/**
 * R1 sprint 2 + sprint 5 — read tool implementations.
 *
 * Direct library entry points for all 11 F2 read tools. The MCP wrapper in
 * `index.ts` delegates here; tests and downstream library callers may also
 * import these functions directly (per the dual-callable surface rule).
 *
 * S2 coverage:
 *  - `getApiVersion` — real (delegated to `index.ts`'s implementation; the
 *    real handler lives there for bootstrap reasons and is re-exported in
 *    the public index).
 *  - `getStack` / `getOverlay` / `getStackResolution` — real reads via the
 *    storage + resolution layers.
 *  - `getTrustState` — real (R5 S4): recomputes the project's aggregate
 *    trust hash, looks it up in the user-tier trust cache, and reports
 *    the approval state. `getTrustDiff` remains the deferred stub (the
 *    structured per-file diff is not in v1's scope).
 *  - `trustList` — real (R5 S4): lists every approval recorded in the
 *    cache.
 *  - `getModuleState` / `listModules` — no-op (zero modules) per OQ4.
 *  - `getStackConventions` / `getOverlayField` are NOT in this sprint's
 *    scope — they remain `NotImplemented` stubs in `index.ts`.
 *
 * S5 upgrades:
 *  - `getResolvedConfig` — full F2 stable shape via `composeResolvedConfig`.
 *    Cached per canonical project root by the cache singleton; consecutive
 *    calls return byte-identical JSON.
 *  - `getActiveStacks` — derived from the resolved config (active set).
 *  - `getMergedSplicePoints` — derived from the resolved config (the
 *    cascaded overlay with `stack` block stripped, since it is observed
 *    via `getActiveStacks` instead).
 *
 * Determinism:
 *  - Any string sort goes through `localeSort`.
 *  - `projectRoot` is canonicalised via `canonicalizePath` before downstream
 *    use so callers cannot smuggle distinct casings.
 *  - Glob match (detection) goes through `determinism.glob` (picomatch v4).
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import { getLogger, type Logger } from '../logging/logger.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';
import { loadOverlay, type LoadedOverlay, type OverlayTier } from '../storage/overlay-loader.js';
import { loadStack, type LoadedStack } from '../storage/stack-loader.js';
import {
  listInstalledModules,
  loadModuleState,
  type ModuleStateRecord,
} from '../storage/module-loader.js';
import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackResolution,
} from '../resolution/stack-resolution.js';
import {
  composeResolvedConfig,
  composeResolvedConfigSync,
  type ResolvedConfig,
} from '../resolution/resolved-config.js';
import { computeTrustHash } from '../trust/hash.js';
import { readCache, type TrustApproval } from '../trust/cache-io.js';
import { _runPhase1ForTests } from './validate.js';

/** Common options passed to every read tool. */
export interface ReadToolContext {
  /** Optional logger override (tests inject a spy). Defaults to `getLogger()`. */
  logger?: Logger;
  /** Forwarded to stack/overlay resolvers. Tests use this for the user tier. */
  userHome?: string;
  /**
   * Forwarded to the C5 stack resolver as the package-tier built-in
   * directory. When unset, the resolver walks up from `import.meta.url`
   * via `packageRoot()`. Tests inject a `mkdtempSync` directory.
   */
  packageRoot?: string;
}

interface PackageMeta {
  version: string;
}

let cachedMeta: PackageMeta | null = null;

function readPackageMetaSync(): PackageMeta {
  if (cachedMeta) return cachedMeta;
  // Read `package.json` from the package root located via the shared
  // helper (which walks up from `import.meta.url` and verifies the
  // package name). Avoids duplicating the walk-up logic here.
  const pkgPath = path.join(resolvePackageRoot(), 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  cachedMeta = { version: parsed.version };
  return cachedMeta;
}

export interface GetStackInput {
  projectRoot: string;
  name: string;
}

export function getStack(
  input: GetStackInput,
  ctx: ReadToolContext = {},
): {
  data: unknown;
  prose: { before: string; after: string };
  sourceTier: 'project' | 'user' | 'builtin';
  sourcePath: string;
} {
  const root = canonicalizePath(input.projectRoot);
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
  const loaded: LoadedStack = loadStack(input.name, root, opts);
  return {
    data: loaded.data,
    prose: loaded.prose,
    sourceTier: loaded.sourceTier,
    sourcePath: loaded.sourcePath,
  };
}

export interface GetActiveStacksInput {
  projectRoot: string;
}

/**
 * Return the active stack set per C2 dispatch. Derived from the cached
 * resolved config (so the dispatch math runs once per project root per
 * server-process lifetime).
 */
export function getActiveStacks(
  input: GetActiveStacksInput,
  ctx: ReadToolContext = {},
): { active: string[] } {
  const root = canonicalizePath(input.projectRoot);
  const apiVersion = readPackageMetaSync().version;
  const resolved = composeResolvedConfigSync(root, apiVersion, {
    userHome: ctx.userHome,
    packageRoot: ctx.packageRoot,
  });
  return { active: resolved.stacks.active.slice() };
}

export interface GetOverlayInput {
  projectRoot: string;
  tier: OverlayTier;
}

export function getOverlay(
  input: GetOverlayInput,
  ctx: ReadToolContext = {},
): {
  data: unknown;
  prose: { before: string; after: string };
  path: string;
  tier: OverlayTier;
} | null {
  const root = canonicalizePath(input.projectRoot);
  const loaded: LoadedOverlay | null = loadOverlay(input.tier, root, {
    userHome: ctx.userHome,
  });
  if (!loaded) return null;
  return {
    data: loaded.data,
    prose: loaded.prose,
    path: loaded.path,
    tier: loaded.tier,
  };
}

export interface GetMergedSplicePointsInput {
  projectRoot: string;
}

/**
 * Return the cascaded overlay (the merged splice-point view) per C4.
 * The returned shape mirrors C3's splice-point catalog: keys are agent
 * role names (`planner`, `proposer`, `evaluator`, etc.) and values are
 * the splice-point payloads. The `stack` block is included so consumers
 * can read the resolved `override` / `cacheEnvOverride`.
 */
export function getMergedSplicePoints(
  input: GetMergedSplicePointsInput,
  ctx: ReadToolContext = {},
): { mergedSplicePoints: Record<string, unknown> } {
  const root = canonicalizePath(input.projectRoot);
  const apiVersion = readPackageMetaSync().version;
  const resolved = composeResolvedConfigSync(root, apiVersion, {
    userHome: ctx.userHome,
    packageRoot: ctx.packageRoot,
  });
  return { mergedSplicePoints: resolved.overlay };
}

export interface GetTrustStateInput {
  projectRoot: string;
}

export interface GetTrustStateSummary {
  additionalChecksCount: number;
  perStackOverridesCount: number;
}

export interface GetTrustStateResult {
  approved: boolean;
  currentHash: string;
  approvedHash?: string;
  approvedAt?: string;
  approvedCommit?: string;
  summary?: GetTrustStateSummary;
}

/**
 * Real implementation (R5 S4). Recomputes the project's aggregate trust
 * hash, looks it up in the user-tier trust cache (`~/.claude/gan/trust-
 * cache.json`), and returns the approval state.
 *
 *  - Approved: matching `(canonical projectRoot, aggregateHash)` pair
 *    found in the cache. The result echoes the stored `approvedAt` and,
 *    when present, the `approvedCommit` SHA captured at approve time.
 *  - Not approved: no match. The result includes a small summary derived
 *    from the project-tier overlay (today: count of
 *    `evaluator.additionalChecks` entries) so callers can present the
 *    user with a concrete description of what would be approved.
 *
 * Pure read: never mutates the cache and never logs. Path comparisons go
 * through `canonicalizePath` (per F3 determinism); hash recomputation
 * routes through `computeTrustHash` (per the single-implementation rule).
 */
export function getTrustState(
  input: GetTrustStateInput,
  ctx: ReadToolContext & { homeDir?: string } = {},
): GetTrustStateResult {
  const { aggregateHash: currentHash } = computeTrustHash(input.projectRoot);
  const homeDir = ctx.homeDir ?? os.homedir();
  const canonRoot = canonicalizePath(input.projectRoot);

  const cache = readCache(homeDir);
  const found = cache.approvals.find(
    (a) => a.projectRoot === canonRoot && a.aggregateHash === currentHash,
  );

  if (found !== undefined) {
    const result: GetTrustStateResult = {
      approved: true,
      currentHash,
      approvedHash: found.aggregateHash,
      approvedAt: found.approvedAt,
    };
    if (found.approvedCommit !== undefined) {
      result.approvedCommit = found.approvedCommit;
    }
    return result;
  }

  // Unapproved: derive a small summary so the caller (the trust prompt)
  // can describe what it would be approving. We re-use the phase-1
  // discovery snapshot helper to load the project-tier overlay without
  // duplicating the loader pipeline here.
  const summary = computeProjectSummary(input.projectRoot, ctx);
  return {
    approved: false,
    currentHash,
    summary,
  };
}

export interface GetTrustDiffInput {
  projectRoot: string;
}

/**
 * Deferred per R5 S4 — the structured per-file trust diff is a future
 * task (the prompt's `[v]` flow today suggests a `git diff` invocation
 * instead). The stub returns the same shape it has shipped since R1 so
 * existing consumers continue to compile.
 */
export function getTrustDiff(
  _input: GetTrustDiffInput,
  ctx: ReadToolContext = {},
): { diff: never[]; reason: 'trust-not-yet-implemented' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust diff is deferred; getTrustDiff returns an empty diff', {
    tool: 'getTrustDiff',
  });
  return { diff: [], reason: 'trust-not-yet-implemented' };
}

/**
 * Reserved for future filtering knobs (e.g. by host or by recency). v1
 * takes no input — see `trustList` below. Kept as a type alias rather
 * than an interface so the empty shape does not trip
 * `no-empty-object-type` lint.
 */
export type TrustListInput = Record<string, never>;

export interface TrustListResult {
  approvals: TrustApproval[];
}

/**
 * List every approval in the user-tier trust cache. Pure read: never
 * mutates the cache. Output preserves the cache's on-disk order (already
 * locale-sorted by `<projectRoot><aggregateHash>` per `cache-io.ts`).
 */
export function trustList(
  _input: TrustListInput = {},
  ctx: ReadToolContext & { homeDir?: string } = {},
): TrustListResult {
  const cache = readCache(ctx.homeDir ?? os.homedir());
  return { approvals: cache.approvals };
}

/**
 * Build the trust-state summary for the unapproved branch. Counts
 * command-declaring fields in the project-tier overlay only — user-tier
 * and default-tier overlays are not part of the trust gate today (per
 * `trust/integration.ts`). The two counted shapes are the bare list form
 * (`evaluator.additionalChecks: [...]`) and the structured wrapper form
 * (`evaluator.additionalChecks: { discardInherited, value: [...] }`),
 * matching the predicate in `trust/integration.projectDeclaresCommands`.
 *
 * `perStackOverridesCount` is reserved for the per-stack
 * `auditCmd`/`buildCmd`/`testCmd`/`lintCmd` override count — that surface
 * is post-E1 work (per the TODO in `trust/integration.ts`), so v1 returns
 * `0` here.
 */
function computeProjectSummary(
  projectRoot: string,
  ctx: ReadToolContext = {},
): GetTrustStateSummary {
  const phase1Ctx: { userHome?: string; packageRoot?: string } = {};
  if (ctx.userHome) phase1Ctx.userHome = ctx.userHome;
  if (ctx.packageRoot) phase1Ctx.packageRoot = ctx.packageRoot;
  const snapshot = _runPhase1ForTests(projectRoot, phase1Ctx);
  const projectRow = snapshot.overlays.project;
  let additionalChecksCount = 0;
  if (projectRow && isObject(projectRow.data)) {
    const evaluator = projectRow.data['evaluator'];
    if (isObject(evaluator)) {
      const checks = evaluator['additionalChecks'];
      if (Array.isArray(checks)) {
        additionalChecksCount = checks.length;
      } else if (isObject(checks) && Array.isArray(checks['value'])) {
        additionalChecksCount = (checks['value'] as unknown[]).length;
      }
    }
  }
  return { additionalChecksCount, perStackOverridesCount: 0 };
}

export interface GetModuleStateInput {
  projectRoot: string;
  name: string;
}

/** No-op per OQ4. M1 ships real module discovery. */
export function getModuleState(
  input: GetModuleStateInput,
  _ctx: ReadToolContext = {},
): ModuleStateRecord | null {
  const root = canonicalizePath(input.projectRoot);
  return loadModuleState(input.name, root);
}

export interface ListModulesInput {
  projectRoot: string;
}

/** No-op per OQ4. */
export function listModules(
  input: ListModulesInput,
  _ctx: ReadToolContext = {},
): { modules: string[] } {
  const root = canonicalizePath(input.projectRoot);
  return { modules: listInstalledModules(root) };
}

export interface GetStackResolutionInput {
  projectRoot: string;
  name: string;
}

export function getStackResolution(
  input: GetStackResolutionInput,
  ctx: ReadToolContext = {},
): StackResolution {
  const root = canonicalizePath(input.projectRoot);
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
  return resolveStackFile(input.name, root, opts);
}

export interface GetResolvedConfigInput {
  projectRoot: string;
}

/**
 * Return the F2 stable-shape resolved config. Cached per canonical project
 * root by the `cache.ts` singleton; consecutive calls return byte-identical
 * JSON (per F2's snapshot freshness rule).
 *
 * The returned shape:
 *
 *  - `apiVersion` — package semver.
 *  - `schemaVersions` — `{ stack: 1, overlay: 1 }`.
 *  - `stacks: { active, byName }` — active set + per-stack metadata
 *    (tier, path, schemaVersion).
 *  - `overlay` — cascaded overlay (the merged splice-point view).
 *  - `discarded` — list of `<block>.<field>` paths whose upstream
 *    contribution was discarded by `discardInherited` somewhere in the
 *    cascade.
 *  - `additionalContext` — path-resolution status for `planner` and
 *    `proposer` additionalContext entries.
 *  - `issues` — sorted list of every validation/cascade/detection issue.
 */
export async function getResolvedConfig(
  input: GetResolvedConfigInput,
  ctx: ReadToolContext = {},
): Promise<ResolvedConfig> {
  return composeResolvedConfig(input.projectRoot, {
    userHome: ctx.userHome,
    packageRoot: ctx.packageRoot,
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate that `projectRoot` is a non-empty string; throw `MalformedInput` otherwise. */
export function requireProjectRoot(input: unknown, tool: string): string {
  if (!isObject(input) || typeof input.projectRoot !== 'string' || input.projectRoot.length === 0) {
    throw createError('MalformedInput', {
      tool,
      message: `Tool '${tool}' requires a non-empty 'projectRoot' string in its input.`,
    });
  }
  return input.projectRoot;
}

/** Validate that `name` is a non-empty string; throw `MalformedInput` otherwise. */
export function requireName(input: unknown, tool: string): string {
  if (!isObject(input) || typeof input.name !== 'string' || input.name.length === 0) {
    throw createError('MalformedInput', {
      tool,
      message: `Tool '${tool}' requires a non-empty 'name' string in its input.`,
    });
  }
  return input.name;
}

/** Validate that `tier` is one of the three overlay tiers. */
export function requireOverlayTier(input: unknown, tool: string): OverlayTier {
  if (!isObject(input) || typeof input.tier !== 'string') {
    throw createError('MalformedInput', {
      tool,
      message: `Tool '${tool}' requires a 'tier' string in its input.`,
    });
  }
  const tier = input.tier;
  if (tier !== 'default' && tier !== 'user' && tier !== 'project') {
    throw createError('MalformedInput', {
      tool,
      message: `Tool '${tool}' received unknown tier '${tier}'; expected 'default' | 'user' | 'project'.`,
    });
  }
  return tier;
}

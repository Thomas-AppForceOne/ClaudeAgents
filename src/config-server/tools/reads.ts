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
 *  - `getTrustState` / `getTrustDiff` — loud-stub. Return the locked OQ1
 *    shape (`approved: true, reason: "trust-not-yet-implemented"`) and log
 *    a warning per call. Real trust ships with R5.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizePath } from '../determinism/index.js';
import { createError } from '../errors.js';
import { getLogger, type Logger } from '../logging/logger.js';
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

/** Common options passed to every read tool. */
export interface ReadToolContext {
  /** Optional logger override (tests inject a spy). Defaults to `getLogger()`. */
  logger?: Logger;
  /** Forwarded to stack/overlay resolvers. Tests use this for the user tier. */
  userHome?: string;
}

interface PackageMeta {
  version: string;
}

let cachedMeta: PackageMeta | null = null;

function readPackageMetaSync(): PackageMeta {
  if (cachedMeta) return cachedMeta;
  const here = fileURLToPath(import.meta.url);
  // From `dist/config-server/tools/reads.js` (or `src/.../reads.ts`) we walk
  // three levels up to reach `<package>/package.json`.
  const pkgPath = path.resolve(path.dirname(here), '..', '..', '..', 'package.json');
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
  const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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
  });
  return { mergedSplicePoints: resolved.overlay };
}

export interface GetTrustStateInput {
  projectRoot: string;
}

/**
 * Loud-stub per OQ1. Returns the canonical shape and emits a warning per
 * call. Real implementation arrives with R5.
 */
export function getTrustState(
  _input: GetTrustStateInput,
  ctx: ReadToolContext = {},
): { approved: true; reason: 'trust-not-yet-implemented' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust subsystem not implemented; treating as approved', {
    tool: 'getTrustState',
  });
  return { approved: true, reason: 'trust-not-yet-implemented' };
}

export interface GetTrustDiffInput {
  projectRoot: string;
}

/** Loud-stub per OQ1. */
export function getTrustDiff(
  _input: GetTrustDiffInput,
  ctx: ReadToolContext = {},
): { diff: never[]; reason: 'trust-not-yet-implemented' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust subsystem not implemented; treating as approved', {
    tool: 'getTrustDiff',
  });
  return { diff: [], reason: 'trust-not-yet-implemented' };
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
  const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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
  return composeResolvedConfig(input.projectRoot, { userHome: ctx.userHome });
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

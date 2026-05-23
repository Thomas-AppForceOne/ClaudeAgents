

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
  getRegisteredModules,
  loadModuleState,
  type ModuleStateRecord,
} from '../storage/module-loader.js';
import { type ModuleStateStoreOptions } from '../storage/module-state-store.js';
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

export interface ReadToolContext {

  logger?: Logger;

  userHome?: string;

  packageRoot?: string;

  moduleStateStore?: ModuleStateStoreOptions;
}

interface PackageMeta {
  version: string;
}

let cachedMeta: PackageMeta | null = null;

function readPackageMetaSync(): PackageMeta {
  if (cachedMeta) return cachedMeta;

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

export function getTrustDiff(
  _input: GetTrustDiffInput,
  ctx: ReadToolContext = {},
): { diff: never[]; reason: 'trust-diff-deferred' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust diff is deferred; getTrustDiff returns an empty diff', {
    tool: 'getTrustDiff',
  });
  return { diff: [], reason: 'trust-diff-deferred' };
}

export type TrustListInput = Record<string, never>;

export interface TrustListResult {
  approvals: TrustApproval[];
}

export function trustList(
  _input: TrustListInput = {},
  ctx: ReadToolContext & { homeDir?: string } = {},
): TrustListResult {
  const cache = readCache(ctx.homeDir ?? os.homedir());
  return { approvals: cache.approvals };
}

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
  key: string;
}

export function getModuleState(
  input: GetModuleStateInput,
  ctx: ReadToolContext = {},
): ModuleStateRecord | null {
  const root = canonicalizePath(input.projectRoot);
  return loadModuleState(input.name, input.key, root, ctx.moduleStateStore);
}

export interface ListModulesInput {
  projectRoot: string;
}

export function listModules(
  input: ListModulesInput,
  _ctx: ReadToolContext = {},
): { modules: string[] } {
  void input;
  const registered = getRegisteredModules();
  return { modules: registered.map((r) => r.name) };
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

export function requireProjectRoot(input: unknown, tool: string): string {
  if (!isObject(input) || typeof input.projectRoot !== 'string' || input.projectRoot.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'projectRoot',
      message: `Tool '${tool}' requires a non-empty 'projectRoot' string in its input.`,
    });
  }
  return input.projectRoot;
}

export function requireName(input: unknown, tool: string): string {
  if (!isObject(input) || typeof input.name !== 'string' || input.name.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'name',
      message: `Tool '${tool}' requires a non-empty 'name' string in its input.`,
    });
  }
  return input.name;
}

export function requireOverlayTier(input: unknown, tool: string): OverlayTier {
  if (!isObject(input) || typeof input.tier !== 'string') {
    throw createError('MalformedInput', {
      tool,
      field: 'tier',
      message: `Tool '${tool}' requires a 'tier' string in its input.`,
    });
  }
  const tier = input.tier;
  if (tier !== 'default' && tier !== 'user' && tier !== 'project') {
    throw createError('MalformedInput', {
      tool,
      field: 'tier',
      message: `Tool '${tool}' received unknown tier '${tier}'; expected 'default' | 'user' | 'project'.`,
    });
  }
  return tier;
}

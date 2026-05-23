/**
 * Read tools for the config-server — the query side, mirroring `writes.ts`.
 *
 * Every export here is a side-effect-free lookup over already-persisted config:
 * stacks, overlays, the resolved/merged config, module state, and the trust
 * cache. Two conventions hold across the surface:
 *
 * 1. **`projectRoot` is canonicalised** at the top of each tool, so symlinked or
 *    relative roots resolve to the same underlying directory the writes side
 *    keyed on.
 * 2. **`ctx` is an injection seam.** `userHome`/`packageRoot` redirect where
 *    overlays/stacks/packaged defaults are read from, and `moduleStateStore`
 *    redirects module-state I/O — production passes nothing and uses real
 *    seams; tests point them at fixtures.
 *
 * Failure modes vary per tool and are documented on each: most propagate the
 * underlying loader's `ConfigServerError` (e.g. `UnknownStack`, `MissingFile`,
 * `TrustCacheCorrupt`); the `requireX` validators throw `MalformedInput`. None
 * mutate disk.
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

/**
 * Ambient context threaded into every read tool. All fields are optional; an
 * empty `{}` is the production default.
 *
 * @property logger optional structured logger (used by tools that emit
 *   warnings, e.g. {@link getTrustDiff}); falls back to the ambient logger.
 * @property userHome override for the user's home directory, steering
 *   `user`-tier overlay/stack resolution.
 * @property packageRoot override for the installed-package root, steering where
 *   built-in stacks and packaged defaults are read from.
 * @property moduleStateStore injection seam for the module-state store.
 */
export interface ReadToolContext {

  logger?: Logger;

  userHome?: string;

  packageRoot?: string;

  moduleStateStore?: ModuleStateStoreOptions;
}

/** Minimal slice of the package's own `package.json` this module needs. */
interface PackageMeta {
  version: string;
}

// Process-lifetime cache of the package version. The installed package.json is
// immutable for the life of the process, so reading it once is safe and avoids
// repeated disk reads on hot read paths.
let cachedMeta: PackageMeta | null = null;

/**
 * Read (and memoise) the installed package's `version`, used as the API version
 * fed to config resolution.
 *
 * Reads `package.json` from the resolved package root on first call and caches
 * the result; subsequent calls are pure. Throws if the package root cannot be
 * resolved, the file cannot be read, or it is not valid JSON — all of which
 * indicate a broken install, not user error.
 */
function readPackageMetaSync(): PackageMeta {
  if (cachedMeta) return cachedMeta;

  const pkgPath = path.join(resolvePackageRoot(), 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  cachedMeta = { version: parsed.version };
  return cachedMeta;
}

/**
 * Input to {@link getStack}.
 *
 * @property projectRoot project directory; canonicalised before resolution.
 * @property name the stack name to load; resolved across tiers (project wins
 *   over user wins over built-in).
 */
export interface GetStackInput {
  projectRoot: string;
  name: string;
}

/**
 * Load a single named stack file, returning its parsed body, surrounding prose,
 * and provenance (which tier and exact path it came from).
 *
 * Read-only. Throws the loader's `ConfigServerError` when the stack cannot be
 * resolved or read (e.g. `UnknownStack`, `MissingFile`, or a YAML parse error) —
 * these are not folded into return data here.
 *
 * @param input see {@link GetStackInput}.
 * @param ctx ambient context; `ctx.userHome`/`ctx.packageRoot` steer where the
 *   stack is resolved from.
 * @returns the stack's `data`/`prose` plus `sourceTier` and `sourcePath`
 *   describing which file actually supplied it.
 */
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

/**
 * Input to {@link getActiveStacks}.
 *
 * @property projectRoot project directory; canonicalised before resolution.
 */
export interface GetActiveStacksInput {
  projectRoot: string;
}

/**
 * Report the names of the stacks active for a project, after full config
 * resolution (detection + overrides applied).
 *
 * Read-only; resolves config synchronously. Throws a `ConfigServerError` if
 * resolution fails (e.g. an unresolvable override).
 *
 * @param input see {@link GetActiveStacksInput}.
 * @param ctx ambient context steering resolution.
 * @returns `{ active }` — a defensive copy (`.slice()`) of the active-stack
 *   names, so the caller cannot mutate the resolver's internal array.
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
  // Copy out so callers cannot mutate the resolver's internal array.
  return { active: resolved.stacks.active.slice() };
}

/**
 * Input to {@link getOverlay}.
 *
 * @property projectRoot project directory; canonicalised before resolution.
 * @property tier which overlay tier to load (`project`/`default`/`user`).
 */
export interface GetOverlayInput {
  projectRoot: string;
  tier: OverlayTier;
}

/**
 * Load a single overlay document for the requested tier.
 *
 * Read-only. Throws the loader's `ConfigServerError` on a malformed/unreadable
 * overlay.
 *
 * @param input see {@link GetOverlayInput}.
 * @param ctx ambient context; `ctx.userHome` resolves the `user` tier.
 * @returns the overlay's `data`/`prose`/`path`/`tier`, or `null` when no
 *   overlay file exists for that tier (a normal absence, not an error).
 */
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

/**
 * Input to {@link getMergedSplicePoints}.
 *
 * @property projectRoot project directory; canonicalised before resolution.
 */
export interface GetMergedSplicePointsInput {
  projectRoot: string;
}

/**
 * Return the fully-merged overlay (the "splice points") for a project — the
 * single overlay view after all tiers are composed.
 *
 * Read-only; resolves config synchronously. Throws a `ConfigServerError` on a
 * resolution failure.
 *
 * @param input see {@link GetMergedSplicePointsInput}.
 * @param ctx ambient context steering resolution.
 * @returns `{ mergedSplicePoints }` — the resolved overlay map.
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

/**
 * Input to {@link getTrustState}.
 *
 * @property projectRoot the project to report trust state for; hashed in raw
 *   form and canonicalised for the cache lookup.
 */
export interface GetTrustStateInput {
  projectRoot: string;
}

/**
 * Summary of what an *unapproved* project is asking to run, shown to help the
 * user decide whether to approve.
 *
 * @property additionalChecksCount how many evaluator commands the project
 *   overlay declares.
 * @property perStackOverridesCount reserved; currently always `0` (per-stack
 *   override accounting is not yet wired up).
 */
export interface GetTrustStateSummary {
  additionalChecksCount: number;
  perStackOverridesCount: number;
}

/**
 * Result of {@link getTrustState}.
 *
 * @property approved whether the current config hash has a matching approval.
 * @property currentHash the freshly computed aggregate trust hash.
 * @property approvedHash the hash the stored approval was granted against
 *   (present only when `approved`; equals `currentHash` by construction).
 * @property approvedAt approval timestamp (present only when `approved`).
 * @property approvedCommit git sha captured at approval (present only when
 *   `approved` *and* it was captured).
 * @property summary command-count summary (present only when *not* `approved`,
 *   to inform an approval decision).
 */
export interface GetTrustStateResult {
  approved: boolean;
  currentHash: string;
  approvedHash?: string;
  approvedAt?: string;
  approvedCommit?: string;
  summary?: GetTrustStateSummary;
}

/**
 * Report whether a project's *current* config is approved, plus the supporting
 * detail.
 *
 * Read-only: recomputes the trust hash and reads the trust cache. Throws
 * `TrustCacheCorrupt` ({@link ConfigServerError}) if the cache is unreadable —
 * unlike the trust *gate*, this query does not fold corruption into a result.
 *
 * The two result arms are mutually exclusive: an approved result carries the
 * approval metadata (`approvedHash`/`approvedAt`/optional `approvedCommit`); an
 * unapproved result carries the `summary` instead.
 *
 * @param input see {@link GetTrustStateInput}.
 * @param ctx ambient context plus optional `homeDir` for the cache location
 *   (defaults to `os.homedir()`).
 * @returns the {@link GetTrustStateResult}.
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
    // Only attach approvedCommit when the approval actually captured one, so the
    // field stays absent rather than serialising as undefined.
    if (found.approvedCommit !== undefined) {
      result.approvedCommit = found.approvedCommit;
    }
    return result;
  }

  // Unapproved: attach a summary of what would run, to inform the decision.
  const summary = computeProjectSummary(input.projectRoot, ctx);
  return {
    approved: false,
    currentHash,
    summary,
  };
}

/**
 * Input to {@link getTrustDiff}.
 *
 * @property projectRoot the project a diff would be computed for; currently
 *   unused (the feature is deferred).
 */
export interface GetTrustDiffInput {
  projectRoot: string;
}

/**
 * Placeholder for the (deferred) trust-diff feature: it would describe *what*
 * changed between the approved and current config. Until implemented it always
 * returns an empty diff and logs a warning so callers know the result is a
 * stub, not a "no changes" answer.
 *
 * Side effect: emits one `warn` log line. Never throws.
 *
 * @param _input unused (see {@link GetTrustDiffInput}).
 * @param ctx ambient context; `ctx.logger` receives the deferral warning,
 *   falling back to the ambient logger.
 * @returns `{ diff: [], reason: 'trust-diff-deferred' }` — the `reason`
 *   distinguishes this stub from a genuine empty diff.
 */
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

/** Input to {@link trustList}: this tool takes no parameters. */
export type TrustListInput = Record<string, never>;

/** Result of {@link trustList}: every approval currently in the cache. */
export interface TrustListResult {
  approvals: TrustApproval[];
}

/**
 * List all trust approvals across every project.
 *
 * Read-only. Throws `TrustCacheCorrupt` ({@link ConfigServerError}) if the
 * cache is unreadable.
 *
 * @param _input unused (the tool takes no parameters).
 * @param ctx ambient context plus optional `homeDir` for the cache location
 *   (defaults to `os.homedir()`).
 * @returns `{ approvals }` — the cache's approval list as-is (not a copy);
 *   treat as read-only.
 */
export function trustList(
  _input: TrustListInput = {},
  ctx: ReadToolContext & { homeDir?: string } = {},
): TrustListResult {
  const cache = readCache(ctx.homeDir ?? os.homedir());
  return { approvals: cache.approvals };
}

/**
 * Count the evaluator commands a project declares, for an unapproved
 * {@link getTrustState} summary.
 *
 * Runs phase-1 discovery (via the test-exposed `_runPhase1ForTests`) to load
 * the project overlay, then counts `evaluator.additionalChecks`, accepting both
 * the plain-array and the `{ value: [...] }` provenance-wrapped shapes.
 * `perStackOverridesCount` is always `0` (not yet implemented).
 *
 * @param projectRoot the project to summarise.
 * @param ctx ambient context; `userHome`/`packageRoot` steer discovery.
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

/**
 * Input to {@link getModuleState}.
 *
 * @property projectRoot project directory; canonicalised before lookup.
 * @property name the owning module.
 * @property key the state key to read.
 */
export interface GetModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
}

/**
 * Load a single module's stored state for `key`.
 *
 * Read-only. No allowlist check is applied on read (the allowlist gates
 * writes); a `key` that was never written simply has no file.
 *
 * @param input see {@link GetModuleStateInput}.
 * @param ctx ambient context; `ctx.moduleStateStore` injects the store seam.
 * @returns the {@link ModuleStateRecord}, or `null` when no state exists for
 *   that module/key.
 */
export function getModuleState(
  input: GetModuleStateInput,
  ctx: ReadToolContext = {},
): ModuleStateRecord | null {
  const root = canonicalizePath(input.projectRoot);
  return loadModuleState(input.name, input.key, root, ctx.moduleStateStore);
}

/**
 * Input to {@link listModules}.
 *
 * @property projectRoot accepted for interface symmetry but unused — the module
 *   registry is process-global, not per-project.
 */
export interface ListModulesInput {
  projectRoot: string;
}

/**
 * List the names of all registered modules.
 *
 * Read-only. Reads the process-global module registry; the `input` (and so the
 * `projectRoot`) is intentionally ignored — `void input` documents that and
 * satisfies no-unused-vars.
 *
 * @param input see {@link ListModulesInput} (unused).
 * @param _ctx ambient context (unused).
 * @returns `{ modules }` — the registered module names.
 */
export function listModules(
  input: ListModulesInput,
  _ctx: ReadToolContext = {},
): { modules: string[] } {
  void input;
  const registered = getRegisteredModules();
  return { modules: registered.map((r) => r.name) };
}

/**
 * Input to {@link getStackResolution}.
 *
 * @property projectRoot project directory; canonicalised before resolution.
 * @property name the stack name to resolve.
 */
export interface GetStackResolutionInput {
  projectRoot: string;
  name: string;
}

/**
 * Resolve a stack name to its winning file and tier *without* loading or
 * parsing the file — the "where would this stack come from?" query.
 *
 * Read-only. Throws the resolver's `ConfigServerError` (e.g. `UnknownStack`,
 * `MissingFile`) when the name cannot be resolved.
 *
 * @param input see {@link GetStackResolutionInput}.
 * @param ctx ambient context steering resolution.
 * @returns the {@link StackResolution} (path + tier).
 */
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

/**
 * Input to {@link getResolvedConfig}.
 *
 * @property projectRoot project directory; passed through to async composition
 *   (canonicalisation happens inside the composer).
 */
export interface GetResolvedConfigInput {
  projectRoot: string;
}

/**
 * Compose and return the full resolved config for a project.
 *
 * The only async tool here: it uses {@link composeResolvedConfig} (the async
 * composer) rather than the `*Sync` variants the other reads use, so detection
 * that needs async I/O can run. Read-only; rejects with a `ConfigServerError`
 * on a resolution failure.
 *
 * @param input see {@link GetResolvedConfigInput}.
 * @param ctx ambient context steering resolution.
 * @returns a promise of the {@link ResolvedConfig}.
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

/** Narrow to a non-null, non-array object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate that untrusted `input` carries a non-empty `projectRoot` string,
 * returning it. A shared input guard used by the tool dispatch layer to fail
 * fast on malformed requests before a tool runs.
 *
 * Throws `MalformedInput` ({@link ConfigServerError}) — naming the offending
 * `tool` and `projectRoot` field — when `input` is not an object, lacks the
 * field, or it is empty/non-string.
 *
 * @param input the raw, untrusted tool input.
 * @param tool the calling tool's name, embedded in the error for diagnostics.
 * @returns the validated `projectRoot`.
 */
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

/**
 * Validate that untrusted `input` carries a non-empty `name` string, returning
 * it. Companion to {@link requireProjectRoot} for name-bearing tools.
 *
 * Throws `MalformedInput` when the field is absent, empty, or non-string.
 *
 * @param input the raw, untrusted tool input.
 * @param tool the calling tool's name, embedded in the error.
 * @returns the validated `name`.
 */
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

/**
 * Validate that untrusted `input` carries a valid overlay `tier`, returning it
 * narrowed to {@link OverlayTier}.
 *
 * Throws `MalformedInput` in two distinct cases with different messages: `tier`
 * missing/non-string, or present-but-not one of `default`/`user`/`project`.
 *
 * @param input the raw, untrusted tool input.
 * @param tool the calling tool's name, embedded in the error.
 * @returns the validated overlay tier.
 */
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

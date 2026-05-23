

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';
import { ConfigServerError } from '../errors.js';
import { runAllInvariants } from '../invariants/index.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';
import {
  defaultModulesRoot,
  loadModules,
  type ModuleRegistration,
} from '../storage/module-loader.js';
import { loadOverlay, type LoadedOverlay, type OverlayTier } from '../storage/overlay-loader.js';
import { parseYamlBlock } from '../storage/yaml-block-parser.js';
import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackTier,
} from '../resolution/stack-resolution.js';
import { runTrustCheck } from '../trust/integration.js';
import {
  validateOverlayBodyAgainstSchema,
  validateStackBodyAgainstSchema,
  type Issue,
} from '../validation/schema-check.js';
import { checkUserOverlayForbiddenFields } from '../validation/user-tier-forbidden.js';

export type { Issue };

export interface SnapshotStackRow {
  tier: StackTier;
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

export interface SnapshotOverlayRow {
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

export interface SnapshotModuleRow {
  name: string;
  manifestPath: string;
  pairsWith?: string;
}

export interface ValidationSnapshot {
  projectRoot: string;
  stackFiles: Map<string, SnapshotStackRow>;
  overlays: {
    default: SnapshotOverlayRow | null;
    user: SnapshotOverlayRow | null;
    project: SnapshotOverlayRow | null;
  };
  modules: SnapshotModuleRow[];
  issues: Issue[];
}

export interface ValidateAllInput {
  projectRoot: string;
}

export interface ValidateStackInput {
  projectRoot: string;
  name: string;
}

export interface ValidateOverlayInput {
  projectRoot: string;
  tier: OverlayTier;
}

export interface ValidateContext {

  userHome?: string;

  packageRoot?: string;

  env?: NodeJS.ProcessEnv;

  homeDir?: string;

  modulesRoot?: string;
}

export function validateAll(
  input: ValidateAllInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const snapshot = createSnapshot(input.projectRoot);
  runPhase1Discovery(snapshot, ctx);
  runPhase2SchemaValidation(snapshot);
  runPhase3Invariants(snapshot);
  runPhase4Trust(snapshot, ctx);
  return { issues: snapshot.issues };
}

export function validateStack(
  input: ValidateStackInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const root = canonicalizePath(input.projectRoot);
  const issues: Issue[] = [];
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;

  let resolved: { path: string; tier: StackTier };
  try {
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
    if (e instanceof ConfigServerError && e.code === 'MissingFile') {
      issues.push({
        code: 'MissingFile',
        message: missingStackMessage(input.name, e.message),
        severity: 'error',
      });
      return { issues };
    }
    throw e;
  }

  validateStackFileFromDisk(resolved.path, issues);
  return { issues };
}

export function validateOverlay(
  input: ValidateOverlayInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const root = canonicalizePath(input.projectRoot);
  const issues: Issue[] = [];

  const overlayLoadOpts = ctx.userHome ? { userHome: ctx.userHome } : {};
  let loaded: LoadedOverlay | null = null;
  try {
    loaded = loadOverlay(input.tier, root, overlayLoadOpts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push(issueFromConfigServerError(e));
      return { issues };
    }
    throw e;
  }

  if (!loaded) return { issues };
  validateOverlayBodyAgainstSchema(loaded.path, loaded.data, issues);
  return { issues };
}

function createSnapshot(projectRoot: string): ValidationSnapshot {
  const root = canonicalizePath(projectRoot);
  return {
    projectRoot: root,
    stackFiles: new Map(),
    overlays: { default: null, user: null, project: null },
    modules: [],
    issues: [],
  };
}

function loadModuleRegistrationsFor(ctx: ValidateContext): ModuleRegistration[] {
  if (typeof ctx.modulesRoot === 'string' && ctx.modulesRoot.length > 0) {
    return loadModules(ctx.modulesRoot);
  }
  let prodRoot: string;
  try {
    prodRoot = defaultModulesRoot();
  } catch {
    return [];
  }
  try {
    return loadModules(prodRoot);
  } catch (e) {

    if (e instanceof ConfigServerError) throw e;
    throw e;
  }
}

function runPhase1Discovery(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const root = snapshot.projectRoot;

  const pkgRoot = resolvePackageRootForDiscovery(ctx.packageRoot);
  if (pkgRoot) {
    enumerateTierStacks(path.join(pkgRoot, 'stacks')).forEach((p) => {
      snapshot.stackFiles.set(`builtin:${p}`, { tier: 'builtin', path: p });
    });
  }

  enumerateBuiltinStacks(root).forEach((p) => {
    snapshot.stackFiles.set(`builtin:${p}`, { tier: 'builtin', path: p });
  });

  enumerateTierStacks(path.join(root, '.claude', 'gan', 'stacks')).forEach((p) => {
    snapshot.stackFiles.set(`project:${p}`, { tier: 'project', path: p });
  });

  const userHome = resolveUserHomeForDiscovery(ctx.userHome);
  if (userHome) {
    enumerateTierStacks(path.join(userHome, '.claude', 'gan', 'stacks')).forEach((p) => {
      snapshot.stackFiles.set(`user:${p}`, { tier: 'user', path: p });
    });
  }

  const overlayLoadOpts = ctx.userHome ? { userHome: ctx.userHome } : {};
  for (const tier of ['default', 'user', 'project'] as const) {
    try {
      const loaded = loadOverlay(tier, root, overlayLoadOpts);
      if (loaded) {
        snapshot.overlays[tier] = {
          path: loaded.path,
          data: loaded.data,
          prose: loaded.prose,
        };
      }
    } catch (e) {
      if (e instanceof ConfigServerError) {
        snapshot.issues.push(issueFromConfigServerError(e));
      } else {
        throw e;
      }
    }
  }

  checkStackOverrideReferences(snapshot, ctx);

  const userOverlay = snapshot.overlays.user;
  if (userOverlay) {
    checkUserOverlayForbiddenFields(userOverlay.path, userOverlay.data, snapshot.issues);
  }

  const registrations = loadModuleRegistrationsFor(ctx);
  for (const reg of registrations) {
    const row: { name: string; manifestPath: string; pairsWith?: string } = {
      name: reg.name,
      manifestPath: reg.manifestPath,
    };
    if (typeof reg.manifest.pairsWith === 'string') {
      row.pairsWith = reg.manifest.pairsWith;
    }
    snapshot.modules.push(row);
  }
}

function enumerateBuiltinStacks(projectRoot: string): string[] {
  return enumerateTierStacks(path.join(projectRoot, 'stacks'));
}

function enumerateTierStacks(stacksDir: string): string[] {
  if (!existsSync(stacksDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(stacksDir);
  } catch {
    return [];
  }
  const matched: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(stacksDir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    matched.push(full);
  }
  return localeSort(matched);
}

function resolveUserHomeForDiscovery(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

function resolvePackageRootForDiscovery(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    return resolvePackageRoot();
  } catch {
    return null;
  }
}

function checkStackOverrideReferences(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row || !isObject(row.data)) continue;
    const stackBlock = row.data['stack'];
    if (!isObject(stackBlock)) continue;
    const override = stackBlock['override'];
    const names = extractOverrideNames(override);
    for (const name of names) {
      try {
        resolveStackFile(name, snapshot.projectRoot, opts);
      } catch (e) {
        if (e instanceof ConfigServerError && e.code === 'MissingFile') {
          snapshot.issues.push({
            code: 'MissingFile',
            path: row.path,
            field: '/stack/override',
            message: `Overlay '${row.path}' references stack '${name}' via stack.override, but no stack file with that name exists in any tier. Create the stack file at .claude/gan/stacks/${name}.md or remove the override entry.`,
            severity: 'error',
          });
        } else {
          throw e;
        }
      }
    }
  }
}

function extractOverrideNames(override: unknown): string[] {
  if (Array.isArray(override)) {
    return override.filter((v): v is string => typeof v === 'string');
  }
  if (isObject(override) && Array.isArray(override.value)) {
    return override.value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function runPhase2SchemaValidation(snapshot: ValidationSnapshot): void {
  const stackKeys = localeSort(Array.from(snapshot.stackFiles.keys()));
  for (const key of stackKeys) {
    const row = snapshot.stackFiles.get(key);
    if (!row) continue;
    validateStackFileFromDisk(row.path, snapshot.issues, row);
  }

  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    validateOverlayBodyAgainstSchema(row.path, row.data, snapshot.issues);
  }
}

function validateStackFileFromDisk(
  filePath: string,
  issues: Issue[],
  prefetched?: SnapshotStackRow,
): void {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    issues.push({
      code: 'MissingFile',
      path: filePath,
      message: `The framework could not read stack file '${filePath}': ${
        e instanceof Error ? e.message : String(e)
      }. Check the file exists and is readable.`,
      severity: 'error',
    });
    return;
  }

  let data: unknown;
  try {
    const parsed = parseYamlBlock(text, filePath);
    data = parsed.data;
    if (prefetched) {
      prefetched.data = parsed.data;
      prefetched.prose = parsed.prose;
    }
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push(issueFromConfigServerError(e));
      return;
    }
    throw e;
  }

  validateStackBodyAgainstSchema(filePath, data, issues);
}

function runPhase3Invariants(snapshot: ValidationSnapshot): void {
  const produced = runAllInvariants(snapshot);
  if (produced.length > 0) snapshot.issues.push(...produced);
}

function runPhase4Trust(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const result = runTrustCheck({
    projectRoot: snapshot.projectRoot,
    snapshot,
    env: ctx.env,
    homeDir: ctx.homeDir,
  });
  if (result.issues.length > 0) snapshot.issues.push(...result.issues);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function missingStackMessage(name: string, original: string): string {
  return `The framework could not find stack '${name}' in any tier. Create '.claude/gan/stacks/${name}.md' (project tier) or 'stacks/${name}.md' (built-in tier). Resolver detail: ${original}`;
}

function issueFromConfigServerError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.file ?? e.path,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}

export function _runPhase1ForTests(
  projectRoot: string,
  ctx: ValidateContext = {},
): ValidationSnapshot {
  const snapshot = createSnapshot(projectRoot);
  runPhase1Discovery(snapshot, ctx);
  return snapshot;
}

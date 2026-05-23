

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { type Logger } from '../logging/logger.js';
import { logTrustEvent } from '../logging/trust-log.js';
import { getResolvedConfigCache, cacheKeyForProjectRoot } from '../resolution/cache.js';
import { resolveStackFile, type ResolveStackOptions } from '../resolution/stack-resolution.js';
import {
  parseYamlBlock,
  serializeYamlBlock,
  type ParsedYamlBlock,
} from '../storage/yaml-block-parser.js';
import { writeYamlBlock } from '../storage/yaml-block-writer.js';
import { atomicWriteFile } from '../storage/atomic-write.js';
import {
  assertStateKeyAllowed,
  getRegisteredModules,
  loadModuleState,
  moduleStatePath,
} from '../storage/module-loader.js';
import { type ModuleStateStoreOptions } from '../storage/module-state-store.js';
import { stableStringify } from '../determinism/index.js';
import {
  readCache,
  removeApprovals,
  upsertApproval,
  writeCache,
  type TrustApproval,
} from '../trust/cache-io.js';
import { computeTrustHash } from '../trust/hash.js';
import {
  validateOverlayBodyAgainstSchema,
  validateStackBodyAgainstSchema,
  type Issue,
} from '../validation/schema-check.js';
import { checkUserOverlayForbiddenFields } from '../validation/user-tier-forbidden.js';
import type { OverlayTier } from '../storage/overlay-loader.js';

export type { Issue };

export interface WriteToolContext {
  logger?: Logger;
  userHome?: string;

  packageRoot?: string;

  moduleStateStore?: ModuleStateStoreOptions;
}

export type WriteResult =
  | { mutated: true; path: string }
  | { mutated: false; issues: Issue[] }
  | { mutated: false; reason: string };

export interface SetOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

export function setOverlayField(
  input: SetOverlayFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const filePath = overlayFilePathFor(input.tier, root, ctx.userHome);
  if (filePath === null) {
    return malformed(
      `setOverlayField: cannot resolve a file path for overlay tier '${input.tier}' (no user home available?).`,
    );
  }

  const segments = parseFieldPath(input.fieldPath, 'setOverlayField');
  if (!segments) return malformed(`setOverlayField: 'fieldPath' must be a non-empty dotted path.`);

  return persistOverlayMutation(filePath, input.tier, root, (data) => {
    setAtPath(data, segments, deepClone(input.value));
  });
}

export interface AppendToOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

export function appendToOverlayField(
  input: AppendToOverlayFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const filePath = overlayFilePathFor(input.tier, root, ctx.userHome);
  if (filePath === null) {
    return malformed(
      `appendToOverlayField: cannot resolve a file path for overlay tier '${input.tier}' (no user home available?).`,
    );
  }

  const segments = parseFieldPath(input.fieldPath, 'appendToOverlayField');
  if (!segments)
    return malformed(`appendToOverlayField: 'fieldPath' must be a non-empty dotted path.`);

  return persistOverlayMutation(filePath, input.tier, root, (data) => {
    appendAtPath(data, segments, deepClone(input.value));
  });
}

export interface RemoveFromOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

export function removeFromOverlayField(
  input: RemoveFromOverlayFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const filePath = overlayFilePathFor(input.tier, root, ctx.userHome);
  if (filePath === null) {
    return malformed(
      `removeFromOverlayField: cannot resolve a file path for overlay tier '${input.tier}'.`,
    );
  }

  const segments = parseFieldPath(input.fieldPath, 'removeFromOverlayField');
  if (!segments)
    return malformed(`removeFromOverlayField: 'fieldPath' must be a non-empty dotted path.`);

  return persistOverlayMutation(filePath, input.tier, root, (data) => {
    removeAtPath(data, segments, input.value);
  });
}

export interface UpdateStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

export function updateStackField(
  input: UpdateStackFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const segments = parseFieldPath(input.fieldPath, 'updateStackField');
  if (!segments) return malformed(`updateStackField: 'fieldPath' must be a non-empty dotted path.`);

  let resolved: { path: string };
  try {
    const opts: ResolveStackOptions = {};
    if (ctx.userHome) opts.userHome = ctx.userHome;
    if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  return persistStackMutation(resolved.path, root, (data) => {
    setAtPath(data, segments, deepClone(input.value));
  });
}

export interface AppendToStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

export function appendToStackField(
  input: AppendToStackFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const segments = parseFieldPath(input.fieldPath, 'appendToStackField');
  if (!segments)
    return malformed(`appendToStackField: 'fieldPath' must be a non-empty dotted path.`);

  let resolved: { path: string };
  try {
    const opts: ResolveStackOptions = {};
    if (ctx.userHome) opts.userHome = ctx.userHome;
    if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  return persistStackMutation(resolved.path, root, (data) => {
    appendAtPath(data, segments, deepClone(input.value));
  });
}

export interface RemoveFromStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

export function removeFromStackField(
  input: RemoveFromStackFieldInput,
  ctx: WriteToolContext = {},
): WriteResult {
  const root = canonicalizePath(input.projectRoot);
  const segments = parseFieldPath(input.fieldPath, 'removeFromStackField');
  if (!segments)
    return malformed(`removeFromStackField: 'fieldPath' must be a non-empty dotted path.`);

  let resolved: { path: string };
  try {
    const opts: ResolveStackOptions = {};
    if (ctx.userHome) opts.userHome = ctx.userHome;
    if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  return persistStackMutation(resolved.path, root, (data) => {
    removeAtPath(data, segments, input.value);
  });
}

export interface TrustApproveInput {
  projectRoot: string;

  contentHash?: string;

  note?: string;
}

export interface TrustApproveResult {
  mutated: true;
  record: TrustApproval;
}

export function trustApprove(
  input: TrustApproveInput,
  ctx: WriteToolContext & { homeDir?: string } = {},
): TrustApproveResult {
  const { aggregateHash: currentHash } = computeTrustHash(input.projectRoot);
  const homeDir = ctx.homeDir ?? os.homedir();
  const canonRoot = canonicalizePath(input.projectRoot);

  const approvedAt = new Date().toISOString();
  const approvedCommit = captureGitHead(input.projectRoot);

  const record: TrustApproval = {
    projectRoot: canonRoot,
    aggregateHash: currentHash,
    approvedAt,
    ...(approvedCommit !== undefined ? { approvedCommit } : {}),
    ...(input.note !== undefined && input.note.length > 0 ? { note: input.note } : {}),
  };

  const cache = readCache(homeDir);
  const newCache = upsertApproval(cache, record);
  writeCache(homeDir, newCache);

  invalidateCache(canonRoot);

  logTrustEvent({
    action: 'approve',
    projectRoot: input.projectRoot,
    hash: currentHash,
    result: 'approved',
  });

  return { mutated: true, record };
}

export interface TrustRevokeInput {
  projectRoot: string;
}

export interface TrustRevokeResult {
  mutated: boolean;
}

export function trustRevoke(
  input: TrustRevokeInput,
  ctx: WriteToolContext & { homeDir?: string } = {},
): TrustRevokeResult {
  const homeDir = ctx.homeDir ?? os.homedir();

  const cache = readCache(homeDir);
  const beforeLength = cache.approvals.length;
  const newCache = removeApprovals(cache, input.projectRoot);
  writeCache(homeDir, newCache);
  const mutated = newCache.approvals.length !== beforeLength;

  if (mutated) invalidateForProject(input.projectRoot);

  logTrustEvent({
    action: 'revoke',
    projectRoot: input.projectRoot,
    result: mutated ? 'revoked' : 'no-op',
  });

  return { mutated };
}

function captureGitHead(projectRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const sha = out.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export interface SetModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  state: unknown;
}

export function setModuleState(
  input: SetModuleStateInput,
  ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  const root = canonicalizePath(input.projectRoot);
  const filePath = moduleStatePath(root, input.name, input.key, ctx.moduleStateStore);
  ensureDir(path.dirname(filePath));
  atomicWriteFile(filePath, stableStringify(input.state));

  invalidateCache(root);
  return { mutated: true, path: filePath };
}

export type DuplicatePolicy = 'error' | 'skip' | 'allow';

const DUPLICATE_POLICIES: ReadonlySet<DuplicatePolicy> = new Set(['error', 'skip', 'allow']);

export interface AppendToModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  fieldPath: string;
  value: unknown;

  duplicatePolicy?: DuplicatePolicy;
}

export function appendToModuleState(
  input: AppendToModuleStateInput,
  ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  const policy = resolveDuplicatePolicy(input.duplicatePolicy);
  const root = canonicalizePath(input.projectRoot);
  const segments = parseFieldPath(input.fieldPath, 'appendToModuleState');
  if (!segments)
    return malformed(`appendToModuleState: 'fieldPath' must be a non-empty dotted path.`);
  const filePath = moduleStatePath(root, input.name, input.key, ctx.moduleStateStore);
  const data = readModuleStateOrEmpty(root, input.name, input.key, ctx.moduleStateStore);

  const parent = navigateToParent(data, segments);
  const lastKey = segments[segments.length - 1];
  const current = parent[lastKey];
  const cloned = deepClone(input.value);

  if (current === undefined) {

    parent[lastKey] = [cloned];
  } else if (Array.isArray(current)) {
    const isDuplicate = current.some((entry) => deepEqual(entry, cloned));
    if (isDuplicate && policy !== 'allow') {
      return { mutated: false, reason: 'duplicate-entry' };
    }
    current.push(cloned);
  } else if (isObject(current)) {
    const entryKey = extractEntryMapKey(cloned);
    if (entryKey === null) {
      throw createError('MalformedInput', {
        field: '/' + segments.join('/'),
        message:
          `Cannot append to '${segments.join('.')}': stored value is a map, ` +
          `so the appended entry must be an object with a 'key' string property.`,
      });
    }
    const collision = Object.prototype.hasOwnProperty.call(current, entryKey);
    if (collision && policy !== 'allow') {
      return { mutated: false, reason: 'duplicate-entry' };
    }
    current[entryKey] = cloned;
  } else {
    throw createError('MalformedInput', {
      field: '/' + segments.join('/'),
      message:
        `Cannot append to '${segments.join('.')}': stored value at the path ` +
        `is a ${describeShape(current)}; expected an array (list-shape) or a ` +
        `plain object (map-shape).`,
    });
  }

  ensureDir(path.dirname(filePath));
  atomicWriteFile(filePath, stableStringify(data));

  invalidateCache(root);
  return { mutated: true, path: filePath };
}

function resolveDuplicatePolicy(value: unknown): DuplicatePolicy {
  if (value === undefined) return 'error';
  if (typeof value === 'string' && DUPLICATE_POLICIES.has(value as DuplicatePolicy)) {
    return value as DuplicatePolicy;
  }
  throw createError('MalformedInput', {
    field: 'duplicatePolicy',
    message:
      `'duplicatePolicy' must be one of 'error', 'skip', or 'allow'. ` +
      `Received: ${JSON.stringify(value)}.`,
  });
}

function navigateToParent(
  data: Record<string, unknown>,
  segments: string[],
): Record<string, unknown> {
  let cursor: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = cursor[seg];
    if (!isObject(existing)) {
      const next: Record<string, unknown> = {};
      cursor[seg] = next;
      cursor = next;
    } else {
      cursor = existing;
    }
  }
  return cursor;
}

function extractEntryMapKey(entry: unknown): string | null {
  if (!isObject(entry)) return null;
  const k = entry['key'];
  if (typeof k !== 'string' || k.length === 0) return null;
  return k;
}

function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export interface RemoveFromModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  entryKey: string;
}

export function removeFromModuleState(
  input: RemoveFromModuleStateInput,
  ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  if (typeof input.entryKey !== 'string' || input.entryKey.length === 0) {
    return malformed(`removeFromModuleState: 'entryKey' must be a non-empty string.`);
  }
  const root = canonicalizePath(input.projectRoot);
  const filePath = moduleStatePath(root, input.name, input.key, ctx.moduleStateStore);
  if (!existsSync(filePath)) return { mutated: false, reason: 'entry-not-found' };

  const existing = loadModuleState(input.name, input.key, root, ctx.moduleStateStore);
  if (existing === null) return { mutated: false, reason: 'entry-not-found' };
  const stored = existing.state;

  if (Array.isArray(stored)) {
    const idx = stored.findIndex(
      (member) =>
        isObject(member) && typeof member['key'] === 'string' && member['key'] === input.entryKey,
    );
    if (idx === -1) return { mutated: false, reason: 'entry-not-found' };
    const next = stored.slice();
    next.splice(idx, 1);
    atomicWriteFile(filePath, stableStringify(next));

    invalidateCache(root);
    return { mutated: true, path: filePath };
  }

  if (isObject(stored)) {
    if (!Object.prototype.hasOwnProperty.call(stored, input.entryKey)) {
      return { mutated: false, reason: 'entry-not-found' };
    }
    const next: Record<string, unknown> = { ...stored };
    delete next[input.entryKey];
    atomicWriteFile(filePath, stableStringify(next));

    invalidateCache(root);
    return { mutated: true, path: filePath };
  }

  throw createError('MalformedInput', {
    field: input.key,
    message:
      `removeFromModuleState: stored value at module '${input.name}' key '${input.key}' is a ` +
      `${describeShape(stored)}; expected an array (list-shape) or a plain object (map-shape).`,
  });
}

export interface RegisterModuleInput {
  projectRoot: string;
  name: string;
  manifest: unknown;
}

export function registerModule(
  input: RegisterModuleInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  void input.manifest;
  const registry = getRegisteredModules();
  const found = registry.find((r) => r.name === input.name);
  if (!found) {
    return { mutated: false, reason: `unknown-module:${input.name}` };
  }

  invalidateForProject(input.projectRoot);
  return { mutated: true, path: found.manifestPath };
}

function readModuleStateOrEmpty(
  projectRoot: string,
  name: string,
  key: string,
  storeOpts?: ModuleStateStoreOptions,
): Record<string, unknown> {
  const existing = loadModuleState(name, key, projectRoot, storeOpts);
  if (existing === null) return {};
  if (isObject(existing.state)) {
    return deepClone(existing.state) as Record<string, unknown>;
  }
  return {};
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
}

function overlayFilePathFor(
  tier: OverlayTier,
  projectRoot: string,
  userHome?: string,
): string | null {
  switch (tier) {
    case 'project':
      return path.join(projectRoot, '.claude', 'gan', 'project.md');
    case 'default':
      return path.join(projectRoot, '.claude', 'gan', 'default.md');
    case 'user': {
      const home =
        userHome ?? process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
      if (typeof home !== 'string' || home.length === 0) return null;
      return path.join(home, '.claude', 'gan', 'user.md');
    }
  }
}

function persistOverlayMutation(
  filePath: string,
  tier: OverlayTier,
  canonicalRoot: string,
  apply: (data: Record<string, unknown>) => void,
): WriteResult {
  let parsed: ParsedYamlBlock | null = null;
  let originalSource: string | null = null;
  let data: Record<string, unknown>;

  if (existsSync(filePath)) {
    try {
      originalSource = readFileSync(filePath, 'utf8');
      parsed = parseYamlBlock(originalSource, filePath);
    } catch (e) {
      if (e instanceof ConfigServerError) {
        return { mutated: false, issues: [issueFromError(e)] };
      }
      throw e;
    }
    if (parsed.data === null || parsed.data === undefined) {
      data = { schemaVersion: 1 };
    } else if (!isObject(parsed.data)) {
      return malformed(
        `Overlay file '${filePath}' body must be a YAML mapping (object). Update the YAML body to start with key/value pairs.`,
      );
    } else {
      data = deepClone(parsed.data) as Record<string, unknown>;
    }
  } else {

    data = { schemaVersion: 1 };
  }

  apply(data);

  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(filePath, data, issues);

  if (tier === 'user') {
    checkUserOverlayForbiddenFields(filePath, data, issues);
  }
  if (issues.length > 0) return { mutated: false, issues };

  const newSource = buildOverlaySource({ filePath, parsed, originalSource, data });

  try {
    atomicWriteFile(filePath, newSource);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  invalidateCache(canonicalRoot);

  void tier;
  return { mutated: true, path: filePath };
}

function persistStackMutation(
  filePath: string,
  canonicalRoot: string,
  apply: (data: Record<string, unknown>) => void,
): WriteResult {
  let originalSource: string;
  let parsed: ParsedYamlBlock;
  try {
    originalSource = readFileSync(filePath, 'utf8');
    parsed = parseYamlBlock(originalSource, filePath);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  if (!isObject(parsed.data)) {
    return malformed(
      `Stack file '${filePath}' body must be a YAML mapping (object). Update the YAML body to start with key/value pairs.`,
    );
  }
  const data = deepClone(parsed.data) as Record<string, unknown>;
  apply(data);

  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(filePath, data, issues);
  if (issues.length > 0) return { mutated: false, issues };

  const newSource = writeYamlBlock({
    originalSource,
    originalParse: parsed,
    newData: data,
  });

  try {
    atomicWriteFile(filePath, newSource);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  invalidateCache(canonicalRoot);
  return { mutated: true, path: filePath };
}

function buildOverlaySource(input: {
  filePath: string;
  parsed: ParsedYamlBlock | null;
  originalSource: string | null;
  data: Record<string, unknown>;
}): string {
  const { parsed, originalSource, data } = input;
  if (parsed === null || originalSource === null) {

    return serializeYamlBlock(data);
  }
  return writeYamlBlock({
    originalSource,
    originalParse: parsed,
    newData: data,
  });
}

function invalidateCache(canonicalRoot: string): void {
  const cache = getResolvedConfigCache();
  cache.invalidate(cacheKeyForProjectRoot(canonicalRoot));
}

function invalidateForProject(projectRoot: string): void {
  invalidateCache(canonicalizePath(projectRoot));
}

function parseFieldPath(fieldPath: unknown, _tool: string): string[] | null {
  if (typeof fieldPath !== 'string') return null;
  if (fieldPath.length === 0) return null;
  const parts = fieldPath.split('.');
  for (const p of parts) {
    if (p.length === 0) return null;
  }
  return parts;
}

function setAtPath(data: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const existing = cursor[key];
    if (!isObject(existing)) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing;
    }
  }
  cursor[segments[segments.length - 1]] = value;
}

function appendAtPath(data: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const existing = cursor[key];
    if (!isObject(existing)) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing;
    }
  }
  const lastKey = segments[segments.length - 1];
  const current = cursor[lastKey];
  if (current === undefined) {
    cursor[lastKey] = [value];
    return;
  }
  if (!Array.isArray(current)) {
    throw createError('MalformedInput', {
      field: '/' + segments.join('/'),
      message: `Cannot append to '${segments.join('.')}': existing value is not an array.`,
    });
  }
  current.push(value);
}

function removeAtPath(data: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const existing: unknown = cursor[key];
    if (!isObject(existing)) return;
    cursor = existing;
  }
  const lastKey = segments[segments.length - 1];
  const current = cursor[lastKey];
  if (!Array.isArray(current)) return;
  const filtered = current.filter((entry) => !deepEqual(entry, value));
  cursor[lastKey] = filtered;
}

function malformed(message: string): WriteResult {
  return {
    mutated: false,
    issues: [{ code: 'MalformedInput', message, severity: 'error' }],
  };
}

function issueFromError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.file ?? e.path,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;

  return JSON.parse(JSON.stringify(v)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

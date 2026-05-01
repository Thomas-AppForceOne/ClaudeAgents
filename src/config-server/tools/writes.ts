/**
 * R1 sprint 6 — write tool implementations.
 *
 * Direct library entry points for every F2 write tool. The MCP wrapper in
 * `index.ts` delegates here; tests and downstream library callers may also
 * import these functions directly (per the dual-callable surface rule).
 *
 * Three categories per F2:
 *
 *  1. Zone-1 writes (real persistence):
 *     - `setOverlayField` / `appendToOverlayField` / `removeFromOverlayField`
 *       — operate on an overlay tier file (`<root>/.claude/gan/project.md`
 *       or `<userHome>/.claude/gan/user.md`). Composes-if-absent: if the
 *       overlay file does not exist, the helper creates it with the
 *       requested field plus `schemaVersion: 1`.
 *     - `updateStackField` / `appendToStackField` / `removeFromStackField`
 *       — operate on a stack file. Resolution goes through C5 (highest
 *       tier wins); writes typically land on the project-tier shadow
 *       (`.claude/gan/stacks/<name>.md`) when one exists.
 *
 *     Each of these follows the same five-step pipeline:
 *       1. Load the current file (or compose-if-absent for overlays).
 *       2. Apply the requested mutation in memory (deep clone first).
 *       3. Validate the new state through the schema validator. Cross-
 *          file invariants are not re-run on a single-file write — the
 *          orchestrator's next `validateAll` call exercises them.
 *       4. On validation failure: return `{ mutated: false, issues }`
 *          and persist nothing.
 *       5. On success: write via `yaml-block-writer` + `atomicWriteFile`,
 *          invalidate the cache, return `{ mutated: true, path, ... }`.
 *
 *  2. Trust loud-stubs (OQ1):
 *     - `trustApprove` / `trustRevoke` return `{ mutated: false, reason:
 *       'trust-not-yet-implemented' }` and emit a warning per call. Real
 *       trust ships with R5.
 *
 *  3. Module no-ops (OQ4):
 *     - `setModuleState` / `appendToModuleState` / `removeFromModuleState`
 *       / `registerModule` return `{ mutated: false }` silently. Real
 *       module discovery ships with M1.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { getLogger, type Logger } from '../logging/logger.js';
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
  validateOverlayBodyAgainstSchema,
  validateStackBodyAgainstSchema,
  type Issue,
} from '../validation/schema-check.js';
import type { OverlayTier } from '../storage/overlay-loader.js';

export type { Issue };

/** Context shared by every write tool (logger + user-home override). */
export interface WriteToolContext {
  logger?: Logger;
  userHome?: string;
}

/** A canonical mutation result. */
export type WriteResult =
  | { mutated: true; path: string }
  | { mutated: false; issues: Issue[] }
  | { mutated: false; reason: string };

// ---- overlay writes -------------------------------------------------------

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

// ---- stack writes ---------------------------------------------------------

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
    const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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
    const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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
    const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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

// ---- trust loud-stubs (OQ1) ----------------------------------------------

export interface TrustApproveInput {
  projectRoot: string;
  contentHash?: string;
}

export function trustApprove(
  _input: TrustApproveInput,
  ctx: WriteToolContext = {},
): { mutated: false; reason: 'trust-not-yet-implemented' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust subsystem not implemented; trustApprove is a no-op until R5', {
    tool: 'trustApprove',
  });
  return { mutated: false, reason: 'trust-not-yet-implemented' };
}

export interface TrustRevokeInput {
  projectRoot: string;
  contentHash?: string;
}

export function trustRevoke(
  _input: TrustRevokeInput,
  ctx: WriteToolContext = {},
): { mutated: false; reason: 'trust-not-yet-implemented' } {
  const logger = ctx.logger ?? getLogger();
  logger.warn('trust subsystem not implemented; trustRevoke is a no-op until R5', {
    tool: 'trustRevoke',
  });
  return { mutated: false, reason: 'trust-not-yet-implemented' };
}

// ---- module no-ops (OQ4) -------------------------------------------------

export interface SetModuleStateInput {
  projectRoot: string;
  name: string;
  state: unknown;
}

export function setModuleState(
  _input: SetModuleStateInput,
  _ctx: WriteToolContext = {},
): { mutated: false } {
  return { mutated: false };
}

export interface AppendToModuleStateInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

export function appendToModuleState(
  _input: AppendToModuleStateInput,
  _ctx: WriteToolContext = {},
): { mutated: false } {
  return { mutated: false };
}

export interface RemoveFromModuleStateInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

export function removeFromModuleState(
  _input: RemoveFromModuleStateInput,
  _ctx: WriteToolContext = {},
): { mutated: false } {
  return { mutated: false };
}

export interface RegisterModuleInput {
  projectRoot: string;
  name: string;
  manifest: unknown;
}

export function registerModule(
  _input: RegisterModuleInput,
  _ctx: WriteToolContext = {},
): { mutated: false } {
  return { mutated: false };
}

// ---- internals -----------------------------------------------------------

/**
 * Resolve the absolute path of an overlay file for a given tier. Mirrors
 * the read-path resolver in `overlay-loader.ts`. Returns `null` if no path
 * can be determined (e.g. user tier with no resolvable home).
 */
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

/**
 * Persist an overlay-file mutation. Composes-if-absent: if the overlay
 * file does not exist, builds a minimal valid skeleton (`schemaVersion: 1`
 * + the requested mutation). Otherwise loads the file, applies the
 * mutation, validates, writes.
 */
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
    // Compose-if-absent: minimal valid overlay skeleton.
    data = { schemaVersion: 1 };
  }

  apply(data);

  // Validate the resulting body against the overlay schema.
  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(filePath, data, issues);
  if (issues.length > 0) return { mutated: false, issues };

  // Build the new file source.
  const newSource = buildOverlaySource({ filePath, parsed, originalSource, data });

  // Persist atomically.
  try {
    atomicWriteFile(filePath, newSource);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  // Invalidate cache.
  invalidateCache(canonicalRoot);
  // `tier` is part of the path (project.md / user.md / default.md) — it
  // does not influence persistence beyond pathing, but we accept it as a
  // parameter for symmetry with the read API.
  void tier;
  return { mutated: true, path: filePath };
}

/**
 * Persist a stack-file mutation. The file must already exist (no
 * compose-if-absent here — stacks are non-trivial enough that creating
 * one mid-run requires a deliberate workflow, not a side effect of a
 * single field write).
 */
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

  // Validate the resulting body against the stack schema.
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

/**
 * Build the on-disk source for an overlay write. Three cases:
 *  - File did not exist → compose minimal source (canonical YAML markers,
 *    no surrounding prose). The skeleton serialises only the YAML body;
 *    the file becomes pure frontmatter.
 *  - File existed and the data is unchanged → return the original bytes
 *    (yaml-block-writer's deep-equal short-circuit).
 *  - File existed and the data changed → re-emit canonical YAML block
 *    flanked by the original prose.
 */
function buildOverlaySource(input: {
  filePath: string;
  parsed: ParsedYamlBlock | null;
  originalSource: string | null;
  data: Record<string, unknown>;
}): string {
  const { parsed, originalSource, data } = input;
  if (parsed === null || originalSource === null) {
    // Compose-if-absent — emit a canonical YAML block with no prose around it.
    return serializeYamlBlock(data);
  }
  return writeYamlBlock({
    originalSource,
    originalParse: parsed,
    newData: data,
  });
}

/** Drop the resolved-config cache entry for a project root after a write. */
function invalidateCache(canonicalRoot: string): void {
  const cache = getResolvedConfigCache();
  cache.invalidate(cacheKeyForProjectRoot(canonicalRoot));
}

// ---- field-path helpers --------------------------------------------------

/**
 * Parse a dotted `fieldPath` (`planner.additionalContext`) into segments.
 * Returns `null` when the input is invalid (empty, non-string, or contains
 * empty segments). Numeric segments are kept as strings — array indexing
 * is intentionally not supported here; callers append/remove against
 * arrays via the dedicated helpers.
 */
function parseFieldPath(fieldPath: unknown, _tool: string): string[] | null {
  if (typeof fieldPath !== 'string') return null;
  if (fieldPath.length === 0) return null;
  const parts = fieldPath.split('.');
  for (const p of parts) {
    if (p.length === 0) return null;
  }
  return parts;
}

/**
 * Set the value at `segments` inside `data`. Creates intermediate objects
 * as needed. The final segment is overwritten.
 */
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

/**
 * Append `value` to the array at `segments` inside `data`. Creates the
 * array if absent. Throws via `createError` if the existing value is not
 * an array.
 */
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

/**
 * Remove every entry deep-equal to `value` from the array at `segments`
 * inside `data`. If the array is absent or the path does not exist, the
 * mutation is a silent no-op (so removing an entry that was never there
 * matches the orchestrator's idempotent intent).
 */
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

// ---- helpers --------------------------------------------------------------

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
  // Structured clone semantics on plain JSON-shaped data are sufficient
  // here — YAML data does not contain Map/Set/Date instances. Fall back
  // to JSON round-trip; faster than `structuredClone` for small payloads
  // and avoids the rare prototype edge case.
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

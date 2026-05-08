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
 *  2. Trust writes (R5 S4):
 *     - `trustApprove` recomputes the project's aggregate hash, persists
 *       a record into the user-tier trust cache (`~/.claude/gan/trust-
 *       cache.json` via `cache-io.writeCache`), and emits an
 *       `action: 'approve'` audit-log line via `logTrustEvent`.
 *     - `trustRevoke` removes every approval for the project from the
 *       cache and emits an `action: 'revoke'` audit-log line.
 *
 *  3. Module no-ops (OQ4):
 *     - `setModuleState` / `appendToModuleState` / `removeFromModuleState`
 *       / `registerModule` return `{ mutated: false }` silently. Real
 *       module discovery ships with M1.
 */

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

/** Context shared by every write tool (logger + user-home override). */
export interface WriteToolContext {
  logger?: Logger;
  userHome?: string;
  /**
   * Forwarded to the C5 stack resolver as the package-tier built-in
   * directory. When unset, the resolver walks up from `import.meta.url`
   * via `packageRoot()`. Tests inject a `mkdtempSync` directory.
   */
  packageRoot?: string;
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

// ---- trust writes (R5 S4) -----------------------------------------------

export interface TrustApproveInput {
  projectRoot: string;
  /**
   * Reserved for future client-supplied verification. v1 ignores any
   * value supplied here and recomputes the aggregate hash from disk so
   * the persisted approval cannot disagree with what the user is
   * actually approving.
   */
  contentHash?: string;
  /** Optional free-form note. Stored verbatim alongside the record. */
  note?: string;
}

export interface TrustApproveResult {
  mutated: true;
  record: TrustApproval;
}

/**
 * Approve the project's current overlay contents. The aggregate hash is
 * recomputed from disk via `computeTrustHash` (the supplied
 * `contentHash` argument is ignored in v1 — see the field doc).
 *
 * The approved record stores:
 *   - `projectRoot` — canonicalised via `canonicalizePath` (per F3).
 *   - `aggregateHash` — recomputed from disk.
 *   - `approvedAt` — ISO-8601 timestamp captured at approval time.
 *   - `approvedCommit` — git HEAD SHA of `projectRoot` when the project
 *     is a git working tree; omitted otherwise. The capture goes
 *     through `child_process.execFileSync('git', …)` and falls through
 *     silently on any failure (no git binary, not a git tree, detached
 *     state with no rev, etc.).
 *   - `note` — supplied verbatim if non-empty.
 *
 * Persists via `upsertApproval` + `writeCache` (no direct file IO).
 * Logs one `action: 'approve'` event via `logTrustEvent` so the audit
 * log captures every approval.
 */
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

/**
 * Revoke every approval for `projectRoot` from the user-tier trust
 * cache. `mutated` reflects whether at least one approval was actually
 * removed; revoking a project with no recorded approvals is a no-op
 * that returns `{ mutated: false }`.
 *
 * Always rewrites the cache file (even on the no-op branch) so the
 * file's existence reflects "we made a decision here". Logs one
 * `action: 'revoke'` event via `logTrustEvent`.
 */
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

  logTrustEvent({
    action: 'revoke',
    projectRoot: input.projectRoot,
    result: mutated ? 'revoked' : 'no-op',
  });

  return { mutated };
}

/**
 * Capture `git rev-parse HEAD` for `projectRoot`. Returns `undefined`
 * on any failure: missing git binary, non-git tree, detached/empty
 * repo, etc. The trust path must never abort because of git
 * environmental issues — `approvedCommit` is metadata, not
 * load-bearing.
 */
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

// ---- module writes (M1) --------------------------------------------------

export interface SetModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  state: unknown;
}

/**
 * Persist the supplied `state` blob for module `name` at the named
 * `key` under `<projectRoot>/.gan-state/modules/<name>/<key>.json`
 * (M3-locked per-key layout). Atomic write via `atomicWriteFile`;
 * serialised with `stableStringify` so the on-disk JSON is canonical
 * (sorted keys, two-space indent, trailing newline) per F3
 * determinism.
 *
 * Whole-value replacement of the named key's blob. The `key` must
 * appear in the module manifest's `stateKeys` allowlist; an
 * undeclared key throws `UnknownStateKey` before any I/O. A module
 * whose manifest omits `stateKeys` cannot persist any state.
 *
 * Other declared keys for the same module are unaffected — each key
 * lives in its own file.
 */
export function setModuleState(
  input: SetModuleStateInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  const root = canonicalizePath(input.projectRoot);
  const filePath = moduleStatePath(root, input.name, input.key);
  ensureDir(path.dirname(filePath));
  atomicWriteFile(filePath, stableStringify(input.state));
  return { mutated: true, path: filePath };
}

/**
 * Recognised duplicate-handling policies for `appendToModuleState`.
 * Matches F2's contract for the corresponding overlay/stack append
 * tools:
 *
 *  - `'error'` (default): a duplicate aborts the write and returns
 *    `{ mutated: false, reason: 'duplicate-entry' }`.
 *  - `'skip'`: same outward result, but semantically "I expected
 *    this might already be there" — also no write.
 *  - `'allow'`: append unconditionally; for list shapes the list
 *    grows even with duplicates, for map shapes the existing key is
 *    overwritten.
 *
 * The default-when-absent is `'error'`; an unrecognised string is
 * rejected at input validation with `MalformedInput` (never silently
 * coerced to the default).
 */
export type DuplicatePolicy = 'error' | 'skip' | 'allow';

const DUPLICATE_POLICIES: ReadonlySet<DuplicatePolicy> = new Set([
  'error',
  'skip',
  'allow',
]);

export interface AppendToModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  fieldPath: string;
  value: unknown;
  /**
   * How to handle a duplicate when the value at `fieldPath` already
   * contains an entry that matches the new one. Default `'error'`.
   * See `DuplicatePolicy` for the per-policy semantics. An
   * unrecognised string throws `MalformedInput` before any I/O.
   */
  duplicatePolicy?: DuplicatePolicy;
}

/**
 * Append `value` to the list-or-map at `fieldPath` inside the
 * module's state blob for the named `key`. Composes-if-absent: when
 * no state file exists for the key, treats the starting state as
 * `{}` and creates the list at the requested path. Loads, mutates,
 * writes via the same atomic pipeline as `setModuleState`.
 *
 * Shape rules (per F2 / M3, mirroring
 * `appendToOverlayField`/`appendToStackField` for keyed entries):
 *
 *   - The stored value at `fieldPath` may be an `Array<unknown>`
 *     (list-shape) or a `Record<string, unknown>` (map-shape).
 *     Anything else throws `ConfigServerError` with
 *     `code === 'MalformedInput'` whose message identifies the
 *     offending shape.
 *   - List-shape: `value` is appended; "duplicate" means deep-equal
 *     to an existing member.
 *   - Map-shape: the input `value` must be an object with a
 *     `key: string` property. The map property whose name equals
 *     `value.key` is the duplicate target.
 *
 * `duplicatePolicy` (default `'error'`) controls what happens on a
 * duplicate hit:
 *
 *   - `'error'` / `'skip'`: return
 *     `{ mutated: false, reason: 'duplicate-entry' }`; no write.
 *   - `'allow'`: append unconditionally; map-shape overwrites the
 *     existing property at `value.key`.
 *
 * The `key` parameter must appear in the manifest's `stateKeys`
 * allowlist; undeclared keys throw `UnknownStateKey` before any I/O.
 */
export function appendToModuleState(
  input: AppendToModuleStateInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  const policy = resolveDuplicatePolicy(input.duplicatePolicy);
  const root = canonicalizePath(input.projectRoot);
  const segments = parseFieldPath(input.fieldPath, 'appendToModuleState');
  if (!segments)
    return malformed(`appendToModuleState: 'fieldPath' must be a non-empty dotted path.`);
  const filePath = moduleStatePath(root, input.name, input.key);
  const data = readModuleStateOrEmpty(root, input.name, input.key);

  const parent = navigateToParent(data, segments);
  const lastKey = segments[segments.length - 1];
  const current = parent[lastKey];
  const cloned = deepClone(input.value);

  if (current === undefined) {
    // Compose-if-absent: initialise as a single-element list.
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
  return { mutated: true, path: filePath };
}

/**
 * Validate `policy` shape and resolve to a concrete
 * `DuplicatePolicy`. `undefined` falls through to the default
 * `'error'`. Any other non-recognised value throws
 * `MalformedInput` so unknown policy strings (e.g. `"replace"`) can
 * never silently coerce to the default.
 */
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

/**
 * Walk `data` to the immediate parent of `segments[last]`, creating
 * intermediate objects on the way (matching the behaviour of
 * `appendAtPath`/`setAtPath`). Returns the parent record so the
 * caller can inspect the child's shape directly.
 */
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

/**
 * Extract the `key` string from an entry intended for a map-shaped
 * field. Returns the key when `entry` is an object with a non-empty
 * `key: string` property; returns `null` otherwise.
 */
function extractEntryMapKey(entry: unknown): string | null {
  if (!isObject(entry)) return null;
  const k = entry['key'];
  if (typeof k !== 'string' || k.length === 0) return null;
  return k;
}

/** Human-readable shape descriptor used in `MalformedInput` messages. */
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

/**
 * Remove a single entry — addressed by `entryKey` — from the module's
 * state blob at the named `key`. Two stored shapes are supported (per
 * F2 / M3):
 *
 *   - **Map-shape**: the file at `<projectRoot>/.gan-state/modules/
 *     <name>/<key>.json` is a plain JSON object. `entryKey` matches
 *     the property name; the property is deleted.
 *   - **List-shape**: the file is a JSON array of records, each
 *     carrying a `key: string` field. `entryKey` matches that field;
 *     the matching member is filtered out.
 *
 * If `entryKey` is not found in either shape (or the file is absent),
 * the call is a silent no-op that returns
 * `{ mutated: false, reason: 'entry-not-found' }` and never touches
 * disk. Removing the last entry leaves `[]` / `{}` on disk — the
 * file is not auto-deleted.
 *
 * The `key` must appear in the manifest's `stateKeys` allowlist;
 * undeclared keys throw `UnknownStateKey` before any I/O.
 *
 * Anything other than a plain object or an array stored at `key` is
 * `MalformedInput` — `removeFromModuleState` has no defined meaning
 * against a scalar.
 */
export function removeFromModuleState(
  input: RemoveFromModuleStateInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  assertStateKeyAllowed(input.name, input.key);
  if (typeof input.entryKey !== 'string' || input.entryKey.length === 0) {
    return malformed(`removeFromModuleState: 'entryKey' must be a non-empty string.`);
  }
  const root = canonicalizePath(input.projectRoot);
  const filePath = moduleStatePath(root, input.name, input.key);
  if (!existsSync(filePath)) return { mutated: false, reason: 'entry-not-found' };

  const existing = loadModuleState(input.name, input.key, root);
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
    return { mutated: true, path: filePath };
  }

  if (isObject(stored)) {
    if (!Object.prototype.hasOwnProperty.call(stored, input.entryKey)) {
      return { mutated: false, reason: 'entry-not-found' };
    }
    const next: Record<string, unknown> = { ...stored };
    delete next[input.entryKey];
    atomicWriteFile(filePath, stableStringify(next));
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

/**
 * `registerModule` is a runtime registration probe. The authoritative
 * registration set is computed by the loader on server start (per AC6
 * — collisions there halt server start). This tool reports whether the
 * named module is currently registered, so external callers can verify
 * that their assumptions hold without reaching for the loader directly.
 *
 * Returns `{ mutated: true }` to signal a successful registration probe;
 * `{ mutated: false, reason: 'unknown-module' }` when the named module
 * is not in the registry.
 */
export function registerModule(
  input: RegisterModuleInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  void input.manifest;
  void input.projectRoot;
  const registry = getRegisteredModules();
  const found = registry.find((r) => r.name === input.name);
  if (!found) {
    return { mutated: false, reason: `unknown-module:${input.name}` };
  }
  return { mutated: true, path: found.manifestPath };
}

function readModuleStateOrEmpty(
  projectRoot: string,
  name: string,
  key: string,
): Record<string, unknown> {
  const existing = loadModuleState(name, key, projectRoot);
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
  // Tier-aware forbidden-field guard (per C3 lines 71-75): a user-tier
  // overlay declaring `planner.additionalContext`,
  // `proposer.additionalContext`, `stack.override`, or
  // `stack.cacheEnvOverride` is rejected before the file touches disk.
  if (tier === 'user') {
    checkUserOverlayForbiddenFields(filePath, data, issues);
  }
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



/**
 * Mutation tools for the config-server.
 *
 * This module is the single write surface for everything the `/gan` loop
 * persists: overlay documents (project/default/user tiers), stack files,
 * the trust-approval cache, and per-module durable state. Every exported
 * entrypoint shares three structural guarantees worth stating once here
 * rather than repeating in each doc block:
 *
 * 1. Mutations are validate-then-write: the in-memory document is mutated
 *    on a deep clone, validated against its schema, and only persisted if
 *    validation produces no issues. A rejected mutation never touches disk.
 * 2. Writes go through {@link atomicWriteFile} (temp-file + rename) so a
 *    crash mid-write cannot leave a half-written config on disk.
 * 3. A successful disk write invalidates the resolved-config cache for the
 *    affected project root, and only after the write lands — so a failed
 *    write never evicts a still-valid cache entry.
 *
 * Soft failures (bad input, schema rejection, duplicate entry) are returned
 * as data in {@link WriteResult}; hard failures (allowlist violations,
 * non-collection shapes, I/O errors that are not `ConfigServerError`)
 * throw. Each export's doc block states which path applies.
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

/**
 * Re-export of the schema-validation {@link Issue} type. Callers that handle
 * a `{ mutated: false; issues }` result need this shape, so it is surfaced
 * from here to spare them an import from the validation layer.
 */
export type { Issue };

/**
 * Ambient context threaded into every write tool. All fields are optional;
 * an empty `{}` is the production default. The fields exist so tests can
 * inject hermetic seams without touching real home directories or git.
 *
 * @property logger optional structured logger; tools log internally and
 *   never surface secrets, so a missing logger is silently fine.
 * @property userHome override for the user's home directory. Used to locate
 *   the `user`-tier overlay; when absent, the tool falls back to
 *   `GAN_USER_HOME`/`HOME`/`USERPROFILE` env vars.
 * @property packageRoot override for the installed-package root, forwarded
 *   to stack resolution so tests can point at a fixture install.
 * @property moduleStateStore injection seam for the module-state store
 *   (home/env/git overrides); production passes nothing and uses real seams.
 */
export interface WriteToolContext {
  logger?: Logger;
  userHome?: string;

  packageRoot?: string;

  moduleStateStore?: ModuleStateStoreOptions;
}

/**
 * Discriminated result returned by the field/state mutation tools. Failure
 * modes are encoded as data rather than thrown so callers can branch on the
 * `mutated` flag without a try/catch:
 *
 * - `{ mutated: true; path }` — the document was written; `path` is the file
 *   that changed (absolute).
 * - `{ mutated: false; issues }` — the mutation was rejected before any
 *   write because schema validation (or a recovered `ConfigServerError`)
 *   produced one or more {@link Issue}s. Disk is untouched.
 * - `{ mutated: false; reason }` — a benign no-op the caller may ignore or
 *   report (e.g. `'duplicate-entry'`, `'entry-not-found'`,
 *   `'unknown-module:<name>'`). Disk is untouched.
 *
 * Invariant: the two non-mutating arms never imply a partial write — either
 * the full new document landed or nothing did.
 */
export type WriteResult =
  | { mutated: true; path: string }
  | { mutated: false; issues: Issue[] }
  | { mutated: false; reason: string };

/**
 * Input to {@link setOverlayField}.
 *
 * @property projectRoot project directory; canonicalised before use, so a
 *   relative or symlinked path is accepted and resolved.
 * @property tier which overlay document to write (`project`/`default`/`user`).
 * @property fieldPath dotted path naming the location to set, e.g.
 *   `runner.thresholdOverride`; intermediate mappings are created on demand.
 * @property value the value to store; deep-cloned before insertion so the
 *   caller may keep mutating their copy without affecting the written doc.
 */
export interface SetOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

/**
 * Set a single overlay field to `value`, creating intermediate mappings as
 * needed (last-writer-wins at the leaf).
 *
 * Side effects (on success only): writes the overlay file atomically and
 * invalidates the resolved-config cache for the canonical project root.
 *
 * Failure modes, all returned as a non-mutating {@link WriteResult} (no throw):
 * - `tier` is `user` but no home directory can be resolved → `{ issues }`.
 * - `fieldPath` is not a non-empty dotted path → `{ issues }`.
 * - the existing overlay body is not a YAML mapping, or the post-mutation
 *   document fails schema validation (or, for the `user` tier, sets a
 *   forbidden field) → `{ issues }`.
 * - an I/O error during the atomic write surfaces as `{ issues }` rather
 *   than propagating, when it arrives as a `ConfigServerError`.
 *
 * @param input see {@link SetOverlayFieldInput}.
 * @param ctx ambient context; `ctx.userHome` resolves the `user` tier.
 */
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

/**
 * Input to {@link appendToOverlayField}.
 *
 * @property projectRoot project directory; canonicalised before use.
 * @property tier which overlay document to write.
 * @property fieldPath dotted path naming the list to append to; intermediate
 *   mappings are created on demand, and an absent leaf becomes a new
 *   single-element list.
 * @property value element to append; deep-cloned before insertion.
 */
export interface AppendToOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

/**
 * Append `value` to the list at `fieldPath` in an overlay document. If the
 * leaf is absent it is seeded as a one-element list; if it exists but is not
 * an array the underlying append throws `MalformedInput` (a hard error,
 * because appending to a scalar is a caller mistake, not a soft no-op).
 *
 * Side effects (on success only): atomic file write + cache invalidation for
 * the canonical project root.
 *
 * Failure modes returned as a non-mutating {@link WriteResult}: unresolvable
 * `user`-tier home, malformed `fieldPath`, non-mapping overlay body, schema
 * rejection, `user`-tier forbidden field, or a recovered I/O error.
 *
 * @param input see {@link AppendToOverlayFieldInput}.
 * @param ctx ambient context; `ctx.userHome` resolves the `user` tier.
 */
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

/**
 * Input to {@link removeFromOverlayField}.
 *
 * @property projectRoot project directory; canonicalised before use.
 * @property tier which overlay document to write.
 * @property fieldPath dotted path naming the list to remove from.
 * @property value the element to remove; matched by deep value equality, so
 *   every structurally-equal entry is dropped. Not cloned (read-only here).
 */
export interface RemoveFromOverlayFieldInput {
  projectRoot: string;
  tier: OverlayTier;
  fieldPath: string;
  value: unknown;
}

/**
 * Remove every list element deep-equal to `value` from the list at
 * `fieldPath`. Removing from an absent or non-list leaf is a silent no-op at
 * the document level (no entries match), but the surrounding validate/write
 * pipeline still runs and a `{ mutated: true }` is returned because the file
 * is rewritten in canonical form.
 *
 * Side effects (on success only): atomic file write + cache invalidation.
 *
 * Failure modes returned as a non-mutating {@link WriteResult}: unresolvable
 * `user`-tier home, malformed `fieldPath`, non-mapping overlay body, schema
 * rejection, `user`-tier forbidden field, or a recovered I/O error.
 *
 * @param input see {@link RemoveFromOverlayFieldInput}.
 * @param ctx ambient context; `ctx.userHome` resolves the `user` tier.
 */
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

/**
 * Input to {@link updateStackField}.
 *
 * @property projectRoot project directory; canonicalised before use.
 * @property name the stack's name; resolved to its on-disk file via the
 *   stack-resolution layer (project tier wins over packaged defaults).
 * @property fieldPath dotted path naming the field to set.
 * @property value value to store; deep-cloned before insertion.
 */
export interface UpdateStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

/**
 * Set a single field in a named stack file, creating intermediate mappings
 * as needed.
 *
 * Side effects (on success only): atomic file write + cache invalidation.
 *
 * Failure modes returned as a non-mutating {@link WriteResult}: malformed
 * `fieldPath`, the stack cannot be resolved (the `ConfigServerError` from
 * resolution — e.g. `UnknownStack` / `MissingFile` — is caught and folded
 * into `{ issues }`), a non-mapping stack body, or schema rejection. A
 * non-`ConfigServerError` thrown by resolution is rethrown unchanged, since
 * it signals an unexpected fault the caller must see.
 *
 * @param input see {@link UpdateStackFieldInput}.
 * @param ctx ambient context; `ctx.userHome`/`ctx.packageRoot` steer where
 *   the stack file is resolved from.
 */
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
    // Resolution failures that are ConfigServerError are expected user-facing
    // outcomes (unknown stack, missing file) and become return data; anything
    // else is an unexpected fault and must propagate, not be swallowed as an
    // "issue".
    if (e instanceof ConfigServerError) {
      return { mutated: false, issues: [issueFromError(e)] };
    }
    throw e;
  }

  return persistStackMutation(resolved.path, root, (data) => {
    setAtPath(data, segments, deepClone(input.value));
  });
}

/**
 * Input to {@link appendToStackField}.
 *
 * @property projectRoot project directory; canonicalised before use.
 * @property name stack name; resolved to its on-disk file.
 * @property fieldPath dotted path naming the list to append to.
 * @property value element to append; deep-cloned before insertion.
 */
export interface AppendToStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

/**
 * Append `value` to the list at `fieldPath` in a named stack file. An absent
 * leaf becomes a one-element list; appending to an existing non-array leaf
 * throws `MalformedInput` (a caller mistake, not a soft no-op).
 *
 * Side effects (on success only): atomic file write + cache invalidation.
 *
 * Failure modes returned as a non-mutating {@link WriteResult}: malformed
 * `fieldPath`, unresolvable stack (`ConfigServerError` folded into `issues`;
 * other throws propagate), non-mapping stack body, or schema rejection.
 *
 * @param input see {@link AppendToStackFieldInput}.
 * @param ctx ambient context steering stack resolution.
 */
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

/**
 * Input to {@link removeFromStackField}.
 *
 * @property projectRoot project directory; canonicalised before use.
 * @property name stack name; resolved to its on-disk file.
 * @property fieldPath dotted path naming the list to remove from.
 * @property value element to remove; matched by deep value equality (every
 *   structurally-equal entry is dropped). Not cloned (read-only here).
 */
export interface RemoveFromStackFieldInput {
  projectRoot: string;
  name: string;
  fieldPath: string;
  value: unknown;
}

/**
 * Remove every list element deep-equal to `value` from the list at
 * `fieldPath` in a named stack file. An absent or non-list leaf matches
 * nothing; the file is still rewritten in canonical form and `{ mutated:
 * true }` is returned.
 *
 * Side effects (on success only): atomic file write + cache invalidation.
 *
 * Failure modes returned as a non-mutating {@link WriteResult}: malformed
 * `fieldPath`, unresolvable stack (`ConfigServerError` folded into `issues`;
 * other throws propagate), non-mapping stack body, or schema rejection.
 *
 * @param input see {@link RemoveFromStackFieldInput}.
 * @param ctx ambient context steering stack resolution.
 */
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

/**
 * Input to {@link trustApprove}.
 *
 * @property projectRoot the project being approved; both hashed (raw form,
 *   so the digest matches what `computeTrustHash` sees) and canonicalised
 *   (stored on the record so lookups are filesystem-case stable).
 * @property contentHash optional caller-supplied hash. Note: the current
 *   implementation always recomputes the aggregate hash from disk and does
 *   not persist this field — it is reserved for callers that want to assert
 *   the hash they observed, and is intentionally not trusted as input.
 * @property note optional free-text annotation; persisted on the record only
 *   when present and non-empty (an empty string is dropped, not stored).
 */
export interface TrustApproveInput {
  projectRoot: string;

  contentHash?: string;

  note?: string;
}

/**
 * Result of {@link trustApprove}: always a successful mutation carrying the
 * approval `record` that was written to the cache.
 */
export interface TrustApproveResult {
  mutated: true;
  record: TrustApproval;
}

/**
 * Record the user's trust approval for `projectRoot`, pinning the current
 * aggregate config hash so later loads can detect tampering.
 *
 * Side effects (this tool is all side effect — there is no soft-failure
 * arm): recomputes the project's aggregate trust hash, writes/updates the
 * approval in the on-disk trust cache, invalidates the resolved-config cache
 * for the canonical root, and emits an `approve`/`approved` trust-log event.
 *
 * Failure modes are thrown, not returned: a corrupt trust cache surfaces as
 * `TrustCacheCorrupt` from the cache read/write, and a cache-write I/O error
 * propagates. There is no `{ mutated: false }` path.
 *
 * Invariants: the stored `aggregateHash` is the hash observed *now* (not the
 * caller's `contentHash`); `approvedAt` is an ISO-8601 timestamp; the git
 * HEAD is captured opportunistically (see {@link captureGitHead}) and
 * omitted when unavailable rather than failing the approval.
 *
 * @param input see {@link TrustApproveInput}.
 * @param ctx ambient context plus an optional `homeDir` override locating
 *   the trust cache (defaults to `os.homedir()`).
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
    // Spread-only-if-present: optional fields are omitted entirely rather
    // than written as `undefined`, so the persisted JSON stays minimal and
    // an empty note never masquerades as a real annotation.
    ...(approvedCommit !== undefined ? { approvedCommit } : {}),
    ...(input.note !== undefined && input.note.length > 0 ? { note: input.note } : {}),
  };

  // Persist before invalidating: the cache eviction must reflect a committed
  // approval, never an in-flight one. If writeCache throws, the resolved-config
  // cache is left intact (still consistent with the unchanged trust state).
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

/**
 * Input to {@link trustRevoke}.
 *
 * @property projectRoot the project whose approvals should be removed;
 *   matched inside `removeApprovals` against stored (canonical) roots.
 */
export interface TrustRevokeInput {
  projectRoot: string;
}

/**
 * Result of {@link trustRevoke}.
 *
 * @property mutated `true` when at least one approval was removed; `false`
 *   when the project had no approval (a no-op, not an error).
 */
export interface TrustRevokeResult {
  mutated: boolean;
}

/**
 * Remove all trust approvals for `projectRoot`. Safe to call when none
 * exist — that case returns `{ mutated: false }`.
 *
 * Side effects: rewrites the trust cache; on an actual removal, invalidates
 * the resolved-config cache for the project; always emits a `revoke`
 * trust-log event whose `result` is `revoked` or `no-op` accordingly.
 *
 * The cache is only invalidated when something was actually removed — a
 * no-op revoke leaves a valid resolved-config cache untouched. Failure modes
 * are thrown (corrupt cache → `TrustCacheCorrupt`; write I/O error
 * propagates); there is no `issues` arm.
 *
 * @param input see {@link TrustRevokeInput}.
 * @param ctx ambient context plus optional `homeDir` override for the cache
 *   location (defaults to `os.homedir()`).
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

  if (mutated) invalidateForProject(input.projectRoot);

  logTrustEvent({
    action: 'revoke',
    projectRoot: input.projectRoot,
    result: mutated ? 'revoked' : 'no-op',
  });

  return { mutated };
}

/**
 * Best-effort capture of the current git HEAD sha for `projectRoot`, used to
 * annotate a trust approval with the commit it was granted against.
 *
 * Returns `undefined` rather than throwing when git is absent, the directory
 * is not a repo, or the command fails for any reason: the commit is a nice-to-
 * have provenance hint, never a precondition for approving, so a missing sha
 * must not block the user. `stderr` is discarded for the same reason.
 *
 * `execFileSync` is used with an argv array (`['-C', projectRoot, …]`) and no
 * shell, so `projectRoot` cannot inject shell syntax — there is no command
 * string for it to escape into.
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

/**
 * Input to {@link setModuleState}.
 *
 * @property projectRoot project directory; canonicalised for the cache key.
 * @property name the module that owns this state; used both for the
 *   allowlist check and to derive the per-module state path.
 * @property key the state key; must be declared in the module manifest's
 *   `stateKeys` allowlist or the write is rejected (thrown).
 * @property state the value to persist wholesale; serialised deterministically
 *   so byte-identical state produces a byte-identical file.
 */
export interface SetModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  state: unknown;
}

/**
 * Overwrite a module's state for `key` with `state` (last-writer-wins; no
 * merge with prior contents).
 *
 * Caller invariant: `key` must be in the module's manifest `stateKeys`
 * allowlist. This is enforced first, before any path resolution or I/O, so a
 * disallowed key never creates a directory or file.
 *
 * Side effects: creates the module-state directory if missing, writes the
 * state file atomically (deterministic serialisation), and invalidates the
 * resolved-config cache for the canonical root.
 *
 * Failure modes are thrown, not returned: `UnknownStateKey` when `key` is not
 * allowlisted; `MalformedInput` from `atomicWriteFile` on an I/O error. On
 * success always returns `{ mutated: true, path }`.
 *
 * @param input see {@link SetModuleStateInput}.
 * @param ctx ambient context; `ctx.moduleStateStore` injects the store seam.
 */
export function setModuleState(
  input: SetModuleStateInput,
  ctx: WriteToolContext = {},
): WriteResult {
  // Allowlist gate runs first, before any path resolution or directory
  // creation, so a key the manifest does not declare can never leave a
  // side effect on disk.
  assertStateKeyAllowed(input.name, input.key);
  const root = canonicalizePath(input.projectRoot);
  const filePath = moduleStatePath(root, input.name, input.key, ctx.moduleStateStore);
  ensureDir(path.dirname(filePath));
  atomicWriteFile(filePath, stableStringify(input.state));

  invalidateCache(root);
  return { mutated: true, path: filePath };
}

/**
 * Duplicate-handling policy for {@link appendToModuleState}:
 * - `error` — reject a duplicate by returning `{ reason: 'duplicate-entry' }`
 *   (the conservative default when the caller omits a policy);
 * - `skip` — also a no-op return on duplicate, but signals the caller chose
 *   to tolerate the collision rather than hit the default;
 * - `allow` — append/overwrite even when a duplicate exists.
 */
export type DuplicatePolicy = 'error' | 'skip' | 'allow';

// Single source of truth for the valid policy strings, used by
// resolveDuplicatePolicy to validate untrusted input without re-listing the
// literals. Module-private (not exported); the DuplicatePolicy type is the
// public surface.
const DUPLICATE_POLICIES: ReadonlySet<DuplicatePolicy> = new Set(['error', 'skip', 'allow']);

/**
 * Input to {@link appendToModuleState}.
 *
 * @property projectRoot project directory; canonicalised for the cache key.
 * @property name owning module; drives allowlist + path.
 * @property key state key; must be allowlisted in the module manifest.
 * @property fieldPath dotted path to the collection inside the state document
 *   to append to; intermediate mappings are created on demand.
 * @property value the entry to append; deep-cloned before insertion.
 * @property duplicatePolicy how to treat a duplicate (see
 *   {@link DuplicatePolicy}); defaults to `error` when omitted.
 */
export interface AppendToModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  fieldPath: string;
  value: unknown;

  duplicatePolicy?: DuplicatePolicy;
}

/**
 * Append `value` to the collection at `fieldPath` within a module's state
 * document. The collection's *shape* decides the append semantics:
 * - absent leaf → seeded as a new single-element list;
 * - list (array) → duplicate detection is deep value equality;
 * - map (plain object) → the entry must carry a non-empty string `key`
 *   property, and duplicate detection is collision on that key.
 *
 * Caller invariants: `key` must be allowlisted (enforced first); when the
 * target leaf is a map, `value` must be an object with a string `key`.
 *
 * Side effects (on success only): creates the directory if missing, atomic
 * write, cache invalidation for the canonical root.
 *
 * Failure modes:
 * - thrown — `UnknownStateKey` (disallowed key), `MalformedInput` (invalid
 *   `duplicatePolicy`, map-target entry without a `key`, or a leaf that is
 *   neither list nor map), `MalformedInput` from the atomic write;
 * - returned as `{ mutated: false }` — malformed `fieldPath` (`issues`), or a
 *   duplicate under a non-`allow` policy (`reason: 'duplicate-entry'`).
 *
 * @param input see {@link AppendToModuleStateInput}.
 * @param ctx ambient context; `ctx.moduleStateStore` injects the store seam.
 */
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

  // Branch on the existing leaf's shape — the same call appends to a list,
  // upserts into a map, or seeds a fresh list, and an incompatible scalar is
  // a hard error rather than a silent coercion.
  if (current === undefined) {

    parent[lastKey] = [cloned];
  } else if (Array.isArray(current)) {
    const isDuplicate = current.some((entry) => deepEqual(entry, cloned));
    if (isDuplicate && policy !== 'allow') {
      return { mutated: false, reason: 'duplicate-entry' };
    }
    current.push(cloned);
  } else if (isObject(current)) {
    // Map-shaped leaf: the entry's own `key` property names its slot, so an
    // entry without one cannot be addressed and is rejected.
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

/**
 * Input to {@link removeFromModuleState}.
 *
 * @property projectRoot project directory; canonicalised for the cache key.
 * @property name owning module; drives allowlist + path.
 * @property key state key; must be allowlisted in the module manifest.
 * @property entryKey identifier of the entry to remove. For a list-shaped
 *   state it matches each member's `key` property; for a map-shaped state it
 *   is the object key. Must be a non-empty string.
 */
export interface RemoveFromModuleStateInput {
  projectRoot: string;
  name: string;
  key: string;
  entryKey: string;
}

/**
 * Remove the entry identified by `entryKey` from a module's state document.
 * The state's shape decides the lookup: in a list, the first member whose
 * `key` equals `entryKey`; in a map, the property named `entryKey`.
 *
 * Caller invariants: `key` allowlisted (enforced first); `entryKey` a
 * non-empty string.
 *
 * Side effects (on an actual removal only): atomic rewrite of the state file
 * and cache invalidation. A "not found" outcome touches nothing.
 *
 * Failure modes:
 * - returned `{ mutated: false }` — invalid `entryKey` (`issues`); the state
 *   file is absent, unreadable-as-state, or holds no matching entry
 *   (`reason: 'entry-not-found'`);
 * - thrown — `UnknownStateKey` (disallowed key); `MalformedInput` when the
 *   stored value is neither a list nor a map.
 *
 * @param input see {@link RemoveFromModuleStateInput}.
 * @param ctx ambient context; `ctx.moduleStateStore` injects the store seam.
 */
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

/**
 * Input to {@link registerModule}.
 *
 * @property projectRoot project whose resolved-config cache is invalidated on
 *   a successful registration lookup.
 * @property name the module to look up in the registry; the lookup key.
 * @property manifest accepted for forward-compatibility but currently unused
 *   (see {@link registerModule}); pass whatever the caller has, including
 *   `undefined`.
 */
export interface RegisterModuleInput {
  projectRoot: string;
  name: string;
  manifest: unknown;
}

/**
 * Confirm a module is registered (by name) and report its manifest path.
 *
 * Side effect (on a found module only): invalidates the resolved-config cache
 * for the project, since registration may change what config resolves to.
 *
 * Failure mode: an unregistered name returns `{ mutated: false, reason:
 * 'unknown-module:<name>' }` — a soft no-op, not a throw. There is no `issues`
 * arm here.
 *
 * @param input see {@link RegisterModuleInput}.
 * @param _ctx ambient context (unused; named with a leading underscore to mark
 *   the deliberate non-use).
 */
export function registerModule(
  input: RegisterModuleInput,
  _ctx: WriteToolContext = {},
): WriteResult {
  // Registration is keyed purely by module name against the existing
  // registry; the manifest is not parsed or persisted here. The parameter is
  // reserved for a future manifest-driven registration path, so we explicitly
  // void it to document the intent (and satisfy no-unused-vars).
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

/**
 * Shared overlay write pipeline: read-or-seed → mutate a clone → validate →
 * write atomically → invalidate cache. Used by all three overlay tools so the
 * ordering guarantee lives in exactly one place.
 *
 * The ordering is load-bearing: validation runs on the post-mutation document
 * *before* any write, so a schema-invalid mutation never reaches disk; the
 * cache is invalidated only *after* the write succeeds, so a rejected or
 * failed mutation never evicts a still-valid cache entry.
 *
 * `parsed`/`originalSource` are threaded to {@link buildOverlaySource} so an
 * existing file's untouched YAML structure (comments, key order) is preserved
 * across the edit rather than reserialised from scratch.
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
      // A parse failure surfaced as ConfigServerError is a malformed-file the
      // caller should see as issues; anything else is an unexpected fault.
      if (e instanceof ConfigServerError) {
        return { mutated: false, issues: [issueFromError(e)] };
      }
      throw e;
    }
    if (parsed.data === null || parsed.data === undefined) {
      // An empty body (file exists but no YAML mapping yet) is seeded with the
      // pinned schema version so the mutation lands in a schema-valid document.
      data = { schemaVersion: 1 };
    } else if (!isObject(parsed.data)) {
      return malformed(
        `Overlay file '${filePath}' body must be a YAML mapping (object). Update the YAML body to start with key/value pairs.`,
      );
    } else {
      // Mutate a clone, never the parser's own object: the original parse is
      // reused below to preserve the file's structure, so it must stay pristine.
      data = deepClone(parsed.data) as Record<string, unknown>;
    }
  } else {
    // No file yet: start from the minimal valid document so a first write to a
    // never-created overlay still satisfies the schema's version requirement.
    data = { schemaVersion: 1 };
  }

  apply(data);

  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(filePath, data, issues);

  // The `user` tier forbids certain fields that lower tiers permit; this extra
  // gate only applies there.
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

  // `tier` has already been consumed (overlay path + forbidden-field gate);
  // voiding it documents that the trailing reference is deliberate, not a
  // forgotten use.
  void tier;
  return { mutated: true, path: filePath };
}

/**
 * Shared stack-file write pipeline, mirroring {@link persistOverlayMutation}:
 * read → mutate a clone → validate → write atomically → invalidate cache.
 * Same ordering guarantee — validate before write, invalidate only after a
 * successful write. A stack file (unlike an overlay) must already exist, so
 * there is no "seed an empty document" branch here.
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
    // No prior file to preserve, so serialize from scratch. When a prior
    // source exists we instead diff against it (below) to keep the user's
    // comments and key ordering intact rather than rewriting the whole block.
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

// Cloned via a JSON round-trip rather than structuredClone/manual recursion:
// overlay and module-state values are always JSON-shaped config data, so the
// round-trip is sufficient and dependency-free. The trade-off is deliberate —
// non-JSON values (Date, Map, functions, undefined, circular refs) are dropped
// or rejected; callers must only pass JSON-serialisable config.
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

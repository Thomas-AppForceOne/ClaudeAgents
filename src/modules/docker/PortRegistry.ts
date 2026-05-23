/**
 * PortRegistry — durable, self-pruning record of host-port allocations, one
 * entry per worktree.
 *
 * The registry persists `{ worktreePath → { port, containerName } }` through
 * the config-server module-state store under module `docker`, key
 * `port-registry`. It is the authoritative layer {@link PortDiscovery} consults
 * before guessing from `docker ps`. Two invariants the class maintains:
 *
 * 1. Ports are unique across worktrees: {@link PortRegistry.register} refuses
 *    (throws `PortInUse`) to assign a port already held by a *different*
 *    worktree, so two live worktrees can never collide on one host port.
 * 2. The registry is keyed by canonical path, and entries for worktrees that no
 *    longer exist on disk are pruned on read (a worktree that was deleted
 *    cannot keep holding its port). Pruning rewrites the store as a side effect
 *    of {@link PortRegistry.load}.
 */

import { existsSync as fsExistsSync } from 'node:fs';

import { canonicalizePath } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { loadModuleState } from '../../config-server/storage/module-loader.js';
import { setModuleState } from '../../config-server/tools/writes.js';

/** Predicate: does a worktree still exist on disk? Injection seam for pruning. */
export type WorktreeExistsProbe = (worktreePath: string) => boolean;

// Production probe: a real filesystem existence check.
const defaultWorktreeExists: WorktreeExistsProbe = (worktreePath) => fsExistsSync(worktreePath);

/**
 * On-disk shape of the registry. `version` is pinned to `1` (validated on load
 * via `SchemaMismatch`); `entries` is keyed by canonical worktree path.
 */
export interface PortRegistryFile {
  version: 1;
  entries: Record<string, { port: number; containerName: string }>;
}

/** A single allocation, as returned by {@link PortRegistry.getAll} (key inlined). */
export interface PortRegistryEntry {
  worktreePath: string;
  port: number;
  containerName: string;
}

// Module-state coordinates: the docker module's `port-registry` key.
const MODULE_NAME = 'docker';
const STATE_KEY = 'port-registry';

/**
 * Construction options.
 *
 * @property worktreeExists override the on-disk existence probe used by
 *   absent-worktree pruning; defaults to a real `fs.existsSync`. Test seam.
 */
export interface PortRegistryOptions {

  worktreeExists?: WorktreeExistsProbe;
}

/**
 * Durable per-project port registry. Construct once per project root; the
 * methods load/persist the backing module-state file on each call (no in-memory
 * caching), so concurrent processes always see the latest persisted state.
 */
export class PortRegistry {
  private readonly projectRoot: string;
  private readonly worktreeExists: WorktreeExistsProbe;

  /**
   * @param projectRoot project whose module-state store holds the registry.
   * @param options see {@link PortRegistryOptions}.
   */
  constructor(projectRoot: string, options: PortRegistryOptions = {}) {
    this.projectRoot = projectRoot;
    this.worktreeExists = options.worktreeExists ?? defaultWorktreeExists;
  }

  /**
   * Allocate `port`/`containerName` to `worktreePath` (last-writer-wins for the
   * same worktree).
   *
   * @param worktreePath worktree to register; canonicalised for the key.
   * @param port host port to assign.
   * @param containerName container name to associate.
   * @throws `PortInUse` if `port` is already held by a *different* worktree —
   *   re-registering the same worktree on its own port is allowed.
   *   Side effect: persists the updated registry.
   */
  register(worktreePath: string, port: number, containerName: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    for (const [otherKey, entry] of Object.entries(blob.entries)) {
      // Skip our own entry so re-registering the same worktree on the same
      // port is a no-conflict update, not a self-collision.
      if (otherKey === key) continue;
      if (entry.port === port) {
        throw createError('PortInUse', {
          message:
            `PortRegistry refuses to register port ${port} for '${worktreePath}': ` +
            `port is already allocated to worktree '${otherKey}'.`,
        });
      }
    }
    blob.entries[key] = { port, containerName };
    this.persist(blob);
  }

  /**
   * Look up the allocation for `worktreePath`.
   *
   * @param worktreePath worktree to look up; canonicalised for the key.
   * @returns the `{ port, containerName }` if registered, else `null`.
   *   Note: because lookup goes through {@link PortRegistry.load}, an entry for
   *   a now-deleted worktree is pruned (and absent from the result) as a side
   *   effect of this read.
   */
  lookup(worktreePath: string): { port: number; containerName: string } | null {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    const entry = blob.entries[key];
    if (!entry) return null;
    return { port: entry.port, containerName: entry.containerName };
  }

  /**
   * Return every allocation, sorted by canonical worktree path for
   * deterministic output. Reads through {@link PortRegistry.load}, so absent
   * worktrees are pruned first.
   */
  getAll(): PortRegistryEntry[] {
    const blob = this.load();
    const keys = Object.keys(blob.entries).sort();
    return keys.map((k) => ({
      worktreePath: k,
      port: blob.entries[k].port,
      containerName: blob.entries[k].containerName,
    }));
  }

  /**
   * Release the allocation for `worktreePath`, if any.
   *
   * @param worktreePath worktree to release; canonicalised for the key.
   *   Side effect: persists only when an entry was actually removed; releasing
   *   an unregistered worktree is a silent no-op (no write).
   */
  release(worktreePath: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    if (deleteEntry(blob, key)) {
      this.persist(blob);
    }
  }

  // Load and validate the registry from module state, pruning entries for
  // worktrees that no longer exist. An absent state file is a fresh empty
  // registry. Pruning that removes anything is persisted immediately, so a
  // read can rewrite the store — the cost of keeping stale ports from
  // accumulating.
  private load(): PortRegistryFile {
    const record = loadModuleState(MODULE_NAME, STATE_KEY, this.projectRoot);
    if (record === null) return { version: 1, entries: {} };
    const blob = validateBlob(record.state);
    if (this.pruneAbsentWorktrees(blob)) {
      this.persist(blob);
    }
    return blob;
  }

  // Drop entries whose worktree no longer exists on disk; returns whether
  // anything was removed (so the caller can decide to persist).
  private pruneAbsentWorktrees(blob: PortRegistryFile): boolean {
    let mutated = false;

    for (const key of Object.keys(blob.entries)) {
      if (this.worktreeExists(key)) continue;

      if (deleteEntry(blob, key)) mutated = true;
    }
    return mutated;
  }

  // Persist the registry through the config-server write tool (atomic write +
  // schema validation live there). Wholesale overwrite of the key.
  private persist(blob: PortRegistryFile): void {
    setModuleState({
      projectRoot: this.projectRoot,
      name: MODULE_NAME,
      key: STATE_KEY,
      state: blob,
    });
  }
}

// Delete an entry by key; returns whether it existed (so callers can skip a
// no-op persist).
function deleteEntry(blob: PortRegistryFile, key: string): boolean {
  if (!(key in blob.entries)) return false;
  delete blob.entries[key];
  return true;
}

// Validate and normalise untrusted module state into a PortRegistryFile.
// Throws MalformedInput when the top level is not an object, and SchemaMismatch
// on an unexpected version. A non-object `entries` is tolerated as empty (the
// registry self-heals). Individual entries with the wrong shape are silently
// dropped rather than failing the whole load, so one bad row cannot lock out
// every other worktree's port.
function validateBlob(state: unknown): PortRegistryFile {
  if (!isObject(state)) {
    throw createError('MalformedInput', {
      message:
        'Docker module state must be a JSON object with shape ' +
        '{ version: 1, entries: { ... } }.',
    });
  }
  if (state['version'] !== 1) {
    throw createError('SchemaMismatch', {
      message: `Docker module state has unsupported version ${String(state['version'])}; expected 1.`,
    });
  }
  const entries = state['entries'];
  if (!isObject(entries)) {
    return { version: 1, entries: {} };
  }
  const out: PortRegistryFile = { version: 1, entries: {} };
  for (const k of Object.keys(entries)) {
    const e = entries[k];
    if (!isObject(e)) continue;
    const port = e['port'];
    const containerName = e['containerName'];
    if (typeof port !== 'number' || typeof containerName !== 'string') continue;
    out.entries[k] = { port, containerName };
  }
  return out;
}

// Plain-object guard (excludes null and arrays).
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

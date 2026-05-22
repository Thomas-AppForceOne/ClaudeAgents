/**
 * PortRegistry — persists worktree → {port, containerName} mappings for
 * the docker module.
 *
 * Persistence is routed through M1's module-state surface
 * (`setModuleState` / `loadModuleState`), keyed by module name
 * "docker" plus the F2/M3 state key "port-registry". Four properties
 * depend on this routing:
 *
 *   1. Cross-process serialisation. Two `/gan` runs both reach the
 *      single Configuration MCP server process; the server mediates
 *      writes. PortRegistry never imports the on-disk file path or
 *      `atomicWriteFile` helper.
 *
 *   2. Black-box rule (F2). Modules don't know about storage layout.
 *      F8 relocated the registry into the central, repo-keyed
 *      module-state store at
 *      `<module-state-root>/<repo-key>/docker/port-registry.json`
 *      (NOT a per-worktree `<projectRoot>/.gan-state/modules/...`
 *      path). PortRegistry never names that path — it passes only the
 *      module name, the state key, and a `projectRoot` (any directory
 *      inside the repo) from which the store derives F7's repo-key via
 *      `git rev-parse --git-common-dir`. The resolution owner is
 *      `module-state-store.ts`; this class is a pure consumer of it.
 *
 *   3. Repo-wide sharing — F8's correctness fix. Because the repo-key
 *      is derived from the shared git-common-dir, every linked worktree
 *      of one repo resolves to the SAME shared file. PortRegistry's
 *      duplicate-port refusal therefore sees allocations made from
 *      *other* worktrees, which is what finally makes M2's
 *      cross-worktree non-collision guarantee hold. Entries stay keyed
 *      by canonical worktree path, so each worktree still gets a
 *      distinct port and container name.
 *
 *   4. Mutation tracking (F2 §"Write functions return a mutation
 *      indicator"). `setModuleState` returns `{mutated, path, ...}`;
 *      callers downstream of PortRegistry that need to refresh caches
 *      can act on it.
 *
 * The only filesystem fact PortRegistry needs is "does this worktree
 * directory still exist?" for prune-on-load. That probe is taken
 * through an injectable {@link WorktreeExistsProbe} seam (default
 * `node:fs existsSync`), so PortRegistry still imports no `node:fs`
 * read helper for the registry file itself and never names the
 * on-disk registry path — the black-box rule above is preserved.
 *
 * The on-disk JSON shape is fixed (unchanged by F8 — only the location
 * and the repo-wide sharing changed):
 *
 *   {
 *     "version": 1,
 *     "entries": {
 *       "<canonical-worktree-path>": {
 *         "port": <number>,
 *         "containerName": "<string>"
 *       }
 *     }
 *   }
 *
 * The constructor takes a project root (any directory inside the repo);
 * tests pass a scratch repo dir.
 *
 * Stale-entry reclamation (F8 §3). Because the shared registry outlives
 * the individual worktrees it tracks, it accumulates entries for
 * worktrees that have been removed. On every load, entries whose keyed
 * worktree path no longer exists on disk are pruned and their host
 * ports freed — reusing the same entry-deletion path `release` uses
 * (see {@link PortRegistry.load} / {@link deleteEntry}). Pruning is
 * conservative: an entry is removed only when its worktree path
 * genuinely no longer exists, so live entries are never touched.
 *
 * Note (M3): F2's per-key contract is honoured end-to-end. Each
 * declared `stateKeys` entry persists to its own `<key>.json` file
 * under `<module-state-root>/<repo-key>/<name>/`. The docker module
 * declares `stateKeys: ["port-registry"]`, so this class routes all
 * reads/writes through `key: "port-registry"`. A second docker
 * subsystem would add a new entry to the manifest and write through
 * `setModuleState('docker', '<new-key>', …)` without conflicting with
 * this file.
 */

import { existsSync as fsExistsSync } from 'node:fs';

import { canonicalizePath } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { loadModuleState } from '../../config-server/storage/module-loader.js';
import { setModuleState } from '../../config-server/tools/writes.js';

/**
 * Probe for "does this worktree directory still exist on disk?", used by
 * prune-on-load. Injectable so tests can simulate a removed worktree
 * without touching the real filesystem; production uses
 * {@link defaultWorktreeExists} (`node:fs existsSync`).
 *
 * The argument is the canonical worktree path (a directory path), NOT
 * the registry file path — PortRegistry never resolves or names the
 * on-disk registry path (F2 black-box rule).
 */
export type WorktreeExistsProbe = (worktreePath: string) => boolean;

/** Default worktree-existence probe: `node:fs existsSync` on the directory. */
const defaultWorktreeExists: WorktreeExistsProbe = (worktreePath) => fsExistsSync(worktreePath);

/** Persisted JSON shape (version 1). */
export interface PortRegistryFile {
  version: 1;
  entries: Record<string, { port: number; containerName: string }>;
}

/** Single decoded entry as exposed via `getAll()`. */
export interface PortRegistryEntry {
  worktreePath: string;
  port: number;
  containerName: string;
}

const MODULE_NAME = 'docker';
const STATE_KEY = 'port-registry';

/** Optional construction seams (tests inject; production uses defaults). */
export interface PortRegistryOptions {
  /**
   * Probe deciding whether a keyed worktree path still exists on disk,
   * used by prune-on-load. Defaults to `node:fs existsSync`.
   */
  worktreeExists?: WorktreeExistsProbe;
}

/**
 * PortRegistry — worktree → {port, containerName} mapping persisted to
 * disk via M1's module-state surface. The constructor takes the project
 * root so persistence routes through `setModuleState`/`loadModuleState`
 * keyed by `name: "docker"`.
 *
 * The `projectRoot` is any directory inside the repo; F8's repo-keyed
 * store derives the shared `<repo-key>` from it, so all worktrees of a
 * repo address one shared registry file.
 */
export class PortRegistry {
  private readonly projectRoot: string;
  private readonly worktreeExists: WorktreeExistsProbe;

  constructor(projectRoot: string, options: PortRegistryOptions = {}) {
    this.projectRoot = projectRoot;
    this.worktreeExists = options.worktreeExists ?? defaultWorktreeExists;
  }

  /**
   * Register a port + container name for `worktreePath`. Throws
   * `PortInUse` if any other worktree has already registered the same
   * port (per AC13's "no two entries share a port" rule).
   *
   * Re-registering the same `worktreePath` with the same port + name is
   * idempotent: the entry is overwritten in place.
   */
  register(worktreePath: string, port: number, containerName: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    for (const [otherKey, entry] of Object.entries(blob.entries)) {
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

  /** Return the entry for `worktreePath`, or `null` when no entry exists. */
  lookup(worktreePath: string): { port: number; containerName: string } | null {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    const entry = blob.entries[key];
    if (!entry) return null;
    return { port: entry.port, containerName: entry.containerName };
  }

  /**
   * Return every registered entry as an array. Output is sorted by
   * worktreePath so iteration order is deterministic across processes.
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
   * Remove the entry for `worktreePath`, freeing its host port. Silent
   * no-op when absent. This is the single entry-deletion path; the
   * prune-on-load reclamation reuses {@link deleteEntry} (which `release`
   * also calls) rather than introducing a parallel deletion routine.
   */
  release(worktreePath: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    if (deleteEntry(blob, key)) {
      this.persist(blob);
    }
  }

  /**
   * Read the registry blob via M1's `loadModuleState`, then prune stale
   * entries (F8 §3). Empty blob when no state file has been written yet.
   * Throws via the factory if the persisted state has the wrong
   * top-level shape (M1 already throws on JSON parse failure).
   *
   * Prune-on-load: a shared registry outlives the worktrees it tracks,
   * so any entry whose keyed worktree path no longer exists on disk is
   * removed here and its host port freed — making that port re-allocatable
   * on the next `register`. The removal goes through the SAME
   * {@link deleteEntry} path `release` uses (REUSE, not a parallel
   * deletion routine). When a prune actually removes something, the
   * reclaimed blob is persisted so the freeing is durable; if nothing is
   * stale the file is left untouched (no spurious write). Pruning is
   * conservative — an entry is dropped only when its worktree path
   * genuinely no longer exists, so live entries are never disturbed.
   */
  private load(): PortRegistryFile {
    const record = loadModuleState(MODULE_NAME, STATE_KEY, this.projectRoot);
    if (record === null) return { version: 1, entries: {} };
    const blob = validateBlob(record.state);
    if (this.pruneAbsentWorktrees(blob)) {
      this.persist(blob);
    }
    return blob;
  }

  /**
   * Prune every entry whose keyed worktree path no longer exists on
   * disk, freeing its host port via the shared {@link deleteEntry} path.
   * Mutates `blob` in place; returns `true` when at least one entry was
   * removed (so the caller persists the reclaimed state).
   */
  private pruneAbsentWorktrees(blob: PortRegistryFile): boolean {
    let mutated = false;
    // Snapshot keys first: deleting while iterating Object.entries is
    // unsafe, and the keys ARE the canonical worktree paths.
    for (const key of Object.keys(blob.entries)) {
      if (this.worktreeExists(key)) continue;
      // Worktree gone → reuse release's entry-deletion path to free the port.
      if (deleteEntry(blob, key)) mutated = true;
    }
    return mutated;
  }

  /** Write the registry blob via M1's `setModuleState`. */
  private persist(blob: PortRegistryFile): void {
    setModuleState({
      projectRoot: this.projectRoot,
      name: MODULE_NAME,
      key: STATE_KEY,
      state: blob,
    });
  }
}

/**
 * The single entry-deletion path: drop `key`'s entry from `blob`, which
 * frees its host port (the port becomes re-allocatable). Returns `true`
 * when an entry was actually removed, `false` when `key` was absent
 * (so `release` stays a silent no-op and prune skips a redundant write).
 * Both `release` (worktree explicitly released) and prune-on-load
 * (worktree gone) route through here — there is no parallel deletion
 * routine.
 */
function deleteEntry(blob: PortRegistryFile, key: string): boolean {
  if (!(key in blob.entries)) return false;
  delete blob.entries[key];
  return true;
}

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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

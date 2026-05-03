/**
 * PortRegistry — persists worktree → {port, containerName} mappings for
 * the docker module.
 *
 * Storage: `<projectRoot>/.gan-state/modules/docker/port-registry.json`.
 *
 * The on-disk JSON shape is fixed:
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
 * The constructor takes an API/handle — *not* a path — so tests can
 * inject an in-memory shim. The default handle is constructed via
 * `createDefaultRegistryApi(projectRoot)` and reads/writes the
 * port-registry file via the project's atomic-write helper plus
 * `stableStringify` (per F3 determinism). Worktree paths are canonicalised
 * via `canonicalizePath` before they become registry keys, so two paths
 * that differ only by symlinks or (on case-insensitive filesystems) case
 * resolve to the same entry.
 *
 * Concurrency: writes serialise through the same on-disk file. Two
 * `register()` calls in the same process see each other (the implementation
 * loads the latest state before each write); two processes both writing at
 * the same moment race the atomic-rename — last write wins for the
 * conflicting fields, but neither write is partial because every write goes
 * through `atomicWriteFile`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';

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

/**
 * The persistence handle the registry uses. Two operations:
 *  - `read()` returns the full {version, entries} blob, or null when no
 *    file exists yet.
 *  - `write(blob)` persists atomically.
 *
 * Tests pass an in-memory shim; production callers use
 * `createDefaultRegistryApi(projectRoot)`.
 */
export interface PortRegistryApi {
  read(): PortRegistryFile | null;
  write(blob: PortRegistryFile): void;
}

/** Resolve the on-disk port-registry path for `projectRoot`. */
export function portRegistryPath(projectRoot: string): string {
  return path.join(projectRoot, '.gan-state', 'modules', 'docker', 'port-registry.json');
}

/**
 * Build the default registry API handle. Reads/writes the
 * port-registry file under `<projectRoot>/.gan-state/modules/docker/`.
 */
export function createDefaultRegistryApi(projectRoot: string): PortRegistryApi {
  const file = portRegistryPath(projectRoot);
  return {
    read(): PortRegistryFile | null {
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw createError('MalformedInput', {
          file,
          message: `Port registry file '${file}' is not valid JSON: ${
            e instanceof Error ? e.message : String(e)
          }.`,
        });
      }
      if (!isObject(parsed)) {
        throw createError('MalformedInput', {
          file,
          message: `Port registry file '${file}' must be a JSON object.`,
        });
      }
      const version = parsed['version'];
      if (version !== 1) {
        throw createError('SchemaMismatch', {
          file,
          message: `Port registry file '${file}' has unsupported version ${String(version)}; expected 1.`,
        });
      }
      const entries = parsed['entries'];
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
    },
    write(blob: PortRegistryFile): void {
      atomicWriteFile(file, stableStringify(blob));
    },
  };
}

/**
 * PortRegistry — worktree → {port, containerName} mapping persisted to
 * disk. The constructor takes only an API/handle; no `projectRoot` or
 * file path leaks into the class itself.
 */
export class PortRegistry {
  private readonly api: PortRegistryApi;

  constructor(api: PortRegistryApi) {
    this.api = api;
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
    const blob = this.loadOrEmpty();
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
    this.api.write(blob);
  }

  /** Return the entry for `worktreePath`, or `null` when no entry exists. */
  lookup(worktreePath: string): { port: number; containerName: string } | null {
    const key = canonicalizePath(worktreePath);
    const blob = this.loadOrEmpty();
    const entry = blob.entries[key];
    if (!entry) return null;
    return { port: entry.port, containerName: entry.containerName };
  }

  /**
   * Return every registered entry as an array. Output is sorted by
   * worktreePath so iteration order is deterministic across processes.
   */
  getAll(): PortRegistryEntry[] {
    const blob = this.loadOrEmpty();
    const keys = Object.keys(blob.entries).sort();
    return keys.map((k) => ({
      worktreePath: k,
      port: blob.entries[k].port,
      containerName: blob.entries[k].containerName,
    }));
  }

  /** Remove the entry for `worktreePath`. Silent no-op when absent. */
  release(worktreePath: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.loadOrEmpty();
    if (!(key in blob.entries)) return;
    delete blob.entries[key];
    this.api.write(blob);
  }

  private loadOrEmpty(): PortRegistryFile {
    const blob = this.api.read();
    if (blob === null) return { version: 1, entries: {} };
    return blob;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

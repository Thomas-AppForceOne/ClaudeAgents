/**
 * PortRegistry — persists worktree → {port, containerName} mappings for
 * the docker module.
 *
 * Persistence is routed through M1's module-state surface
 * (`setModuleState` / `loadModuleState`), keyed by module name "docker".
 * Three properties depend on this routing:
 *
 *   1. Cross-process serialisation. Two `/gan` runs both reach the
 *      single Configuration MCP server process; the server mediates
 *      writes. PortRegistry never imports the on-disk file path or
 *      `atomicWriteFile` helper.
 *
 *   2. Black-box rule (F2). Modules don't know about storage layout.
 *      The on-disk JSON file lives at
 *      `<projectRoot>/.gan-state/modules/docker/state.json` per M1's
 *      `moduleStatePath()`; PortRegistry never names that path.
 *
 *   3. Mutation tracking (F2 §"Write functions return a mutation
 *      indicator"). `setModuleState` returns `{mutated, path, ...}`;
 *      callers downstream of PortRegistry that need to refresh caches
 *      can act on it.
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
 * The constructor takes a project root; tests pass a scratch dir.
 *
 * Note (post-M audit): F2 specifies `setModuleState(moduleName, key,
 * value)` with a `key` parameter so a module can persist multiple
 * named state blobs side-by-side. M1's implementation is whole-blob
 * (`setModuleState({projectRoot, name, state})`) — there is no `key`.
 * PortRegistry therefore owns 100% of the docker module's persisted
 * state. Adding a second docker subsystem with its own state will
 * require either threading F2's `key` parameter through M1 or wrapping
 * additional state under top-level keys inside this module's blob. The
 * manifest's `stateKeys: ["port-registry"]` declaration is decorative
 * until the M1/F2 divergence closes.
 */

import { canonicalizePath } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { loadModuleState } from '../../config-server/storage/module-loader.js';
import { setModuleState } from '../../config-server/tools/writes.js';

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

/**
 * PortRegistry — worktree → {port, containerName} mapping persisted to
 * disk via M1's module-state surface. The constructor takes the project
 * root so persistence routes through `setModuleState`/`loadModuleState`
 * keyed by `name: "docker"`.
 */
export class PortRegistry {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
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

  /** Remove the entry for `worktreePath`. Silent no-op when absent. */
  release(worktreePath: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    if (!(key in blob.entries)) return;
    delete blob.entries[key];
    this.persist(blob);
  }

  /**
   * Read the registry blob via M1's `loadModuleState`. Empty blob when
   * no state file has been written yet. Throws via the factory if the
   * persisted state has the wrong top-level shape (M1 already throws
   * on JSON parse failure).
   */
  private load(): PortRegistryFile {
    const record = loadModuleState(MODULE_NAME, this.projectRoot);
    if (record === null) return { version: 1, entries: {} };
    return validateBlob(record.state);
  }

  /** Write the registry blob via M1's `setModuleState`. */
  private persist(blob: PortRegistryFile): void {
    setModuleState({
      projectRoot: this.projectRoot,
      name: MODULE_NAME,
      state: blob,
    });
  }
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



import { existsSync as fsExistsSync } from 'node:fs';

import { canonicalizePath } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { loadModuleState } from '../../config-server/storage/module-loader.js';
import { setModuleState } from '../../config-server/tools/writes.js';

export type WorktreeExistsProbe = (worktreePath: string) => boolean;

const defaultWorktreeExists: WorktreeExistsProbe = (worktreePath) => fsExistsSync(worktreePath);

export interface PortRegistryFile {
  version: 1;
  entries: Record<string, { port: number; containerName: string }>;
}

export interface PortRegistryEntry {
  worktreePath: string;
  port: number;
  containerName: string;
}

const MODULE_NAME = 'docker';
const STATE_KEY = 'port-registry';

export interface PortRegistryOptions {

  worktreeExists?: WorktreeExistsProbe;
}

export class PortRegistry {
  private readonly projectRoot: string;
  private readonly worktreeExists: WorktreeExistsProbe;

  constructor(projectRoot: string, options: PortRegistryOptions = {}) {
    this.projectRoot = projectRoot;
    this.worktreeExists = options.worktreeExists ?? defaultWorktreeExists;
  }

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

  lookup(worktreePath: string): { port: number; containerName: string } | null {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    const entry = blob.entries[key];
    if (!entry) return null;
    return { port: entry.port, containerName: entry.containerName };
  }

  getAll(): PortRegistryEntry[] {
    const blob = this.load();
    const keys = Object.keys(blob.entries).sort();
    return keys.map((k) => ({
      worktreePath: k,
      port: blob.entries[k].port,
      containerName: blob.entries[k].containerName,
    }));
  }

  release(worktreePath: string): void {
    const key = canonicalizePath(worktreePath);
    const blob = this.load();
    if (deleteEntry(blob, key)) {
      this.persist(blob);
    }
  }

  private load(): PortRegistryFile {
    const record = loadModuleState(MODULE_NAME, STATE_KEY, this.projectRoot);
    if (record === null) return { version: 1, entries: {} };
    const blob = validateBlob(record.state);
    if (this.pruneAbsentWorktrees(blob)) {
      this.persist(blob);
    }
    return blob;
  }

  private pruneAbsentWorktrees(blob: PortRegistryFile): boolean {
    let mutated = false;

    for (const key of Object.keys(blob.entries)) {
      if (this.worktreeExists(key)) continue;

      if (deleteEntry(blob, key)) mutated = true;
    }
    return mutated;
  }

  private persist(blob: PortRegistryFile): void {
    setModuleState({
      projectRoot: this.projectRoot,
      name: MODULE_NAME,
      key: STATE_KEY,
      state: blob,
    });
  }
}

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

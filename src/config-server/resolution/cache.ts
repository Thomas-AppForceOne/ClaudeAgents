

import { statSync } from 'node:fs';

import { canonicalizePath } from '../determinism/index.js';

export type BackingFileStates = ReadonlyMap<string, number | null>;

export interface ResolvedConfigCacheLike<T> {

  get(canonicalRoot: string): T | undefined;

  set(canonicalRoot: string, value: T, backingFileStates?: BackingFileStates): void;

  invalidate(canonicalRoot: string): void;

  clear(): void;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly states: BackingFileStates;
}

export class ResolvedConfigCache<T> implements ResolvedConfigCacheLike<T> {
  private readonly entries: Map<string, CacheEntry<T>>;

  constructor() {
    this.entries = new Map();
  }

  get(canonicalRoot: string): T | undefined {
    const entry = this.entries.get(canonicalRoot);
    if (entry === undefined) return undefined;
    if (backingFilesHaveChanged(entry.states)) {

      this.entries.delete(canonicalRoot);
      return undefined;
    }
    return entry.value;
  }

  set(canonicalRoot: string, value: T, backingFileStates?: BackingFileStates): void {
    const states: BackingFileStates = backingFileStates ?? new Map();
    this.entries.set(canonicalRoot, { value, states });
  }

  invalidate(canonicalRoot: string): void {
    this.entries.delete(canonicalRoot);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

let singleton: ResolvedConfigCache<unknown> | null = null;

export function getResolvedConfigCache<T = unknown>(): ResolvedConfigCache<T> {
  if (singleton === null) {
    singleton = new ResolvedConfigCache<unknown>();
  }
  return singleton as unknown as ResolvedConfigCache<T>;
}

export function clearResolvedConfigCache(): void {
  if (singleton !== null) singleton.clear();
}

export function cacheKeyForProjectRoot(projectRoot: string): string {
  return canonicalizePath(projectRoot);
}

export function backingFileMtime(absolutePath: string): number | null {
  try {
    const s = statSync(absolutePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

function backingFilesHaveChanged(states: BackingFileStates): boolean {
  for (const [absolutePath, recorded] of states) {
    const current = backingFileMtime(absolutePath);
    if (current !== recorded) return true;
  }
  return false;
}

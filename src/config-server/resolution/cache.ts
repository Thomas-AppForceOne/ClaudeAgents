/**
 * In-memory cache for resolved-config values, keyed by canonical project root.
 *
 * Resolving config is expensive (reads + validates the whole overlay/stack
 * cascade), so the composed result is memoised. The cache is *self-validating*
 * on read: each entry records the mtime of every file it was derived from, and
 * a `get` that detects any backing file changed (or appeared/disappeared)
 * evicts the entry and reports a miss. This guarantees a stale config is never
 * served after an edit, without the write side having to know every reader's
 * dependencies. The write tools additionally invalidate explicitly on mutation.
 *
 * Keys must always be the {@link canonicalizePath} form; use
 * {@link cacheKeyForProjectRoot} to derive one so two spellings of the same
 * project share an entry.
 */

import { statSync } from 'node:fs';

import { canonicalizePath } from '../determinism/index.js';

/**
 * A snapshot of the files an entry depends on: absolute path → recorded mtime
 * in ms, or `null` when the file did not exist at record time. Read-only;
 * the cache compares it against live mtimes to detect staleness.
 */
export type BackingFileStates = ReadonlyMap<string, number | null>;

/**
 * Structural contract for the resolved-config cache, so call sites and tests
 * can depend on the interface rather than the concrete class.
 *
 * @method get returns the cached value for a canonical root, or `undefined` on
 *   a miss OR when the entry's backing files have changed (a self-eviction).
 * @method set stores `value` under `canonicalRoot`, optionally recording the
 *   `backingFileStates` that gate later self-validation (omitted ⇒ never
 *   self-invalidates on file change).
 * @method invalidate drops the entry for `canonicalRoot` (no-op if absent).
 * @method clear drops every entry.
 */
export interface ResolvedConfigCacheLike<T> {

  get(canonicalRoot: string): T | undefined;

  set(canonicalRoot: string, value: T, backingFileStates?: BackingFileStates): void;

  invalidate(canonicalRoot: string): void;

  clear(): void;
}

// One stored entry: the memoised value plus the file-state snapshot used to
// decide whether it is still fresh on the next read.
interface CacheEntry<T> {
  readonly value: T;
  readonly states: BackingFileStates;
}

/**
 * Default {@link ResolvedConfigCacheLike} implementation backed by a `Map`.
 * Generic over the cached value type `T` (the singleton stores `unknown` and
 * callers re-narrow).
 */
export class ResolvedConfigCache<T> implements ResolvedConfigCacheLike<T> {
  private readonly entries: Map<string, CacheEntry<T>>;

  constructor() {
    this.entries = new Map();
  }

  /**
   * @returns the cached value, or `undefined` on a plain miss. A hit whose
   *   backing files have since changed is treated as a miss: the entry is
   *   evicted in-line (so the next read recomputes) and `undefined` returned.
   */
  get(canonicalRoot: string): T | undefined {
    const entry = this.entries.get(canonicalRoot);
    if (entry === undefined) return undefined;
    if (backingFilesHaveChanged(entry.states)) {
      // Self-eviction: a dependency changed on disk, so the memoised value is
      // stale. Delete it now so this read and all subsequent ones miss until
      // a fresh value is set.
      this.entries.delete(canonicalRoot);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Store `value`, replacing any existing entry.
   *
   * @param backingFileStates the file snapshot that gates self-validation.
   *   When omitted, an empty map is stored, meaning the entry will never
   *   self-invalidate on a file change (only explicit `invalidate`/`clear`
   *   evicts it) — pass real states whenever the value derives from files.
   */
  set(canonicalRoot: string, value: T, backingFileStates?: BackingFileStates): void {
    const states: BackingFileStates = backingFileStates ?? new Map();
    this.entries.set(canonicalRoot, { value, states });
  }

  /** Evict the entry for `canonicalRoot`; no-op when there is none. */
  invalidate(canonicalRoot: string): void {
    this.entries.delete(canonicalRoot);
  }

  /** Evict every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** Current number of cached entries; primarily for tests/diagnostics. */
  size(): number {
    return this.entries.size;
  }
}

// Process-wide singleton instance. Stored as `unknown` because different call
// sites cache different value types through the same instance.
let singleton: ResolvedConfigCache<unknown> | null = null;

/**
 * Accessor for the process-wide resolved-config cache (lazily created on first
 * use). The `T` parameter only re-narrows the view; every caller shares the
 * one underlying instance, so an `invalidate`/`set` from one path is visible
 * to all the others.
 */
export function getResolvedConfigCache<T = unknown>(): ResolvedConfigCache<T> {
  if (singleton === null) {
    singleton = new ResolvedConfigCache<unknown>();
  }
  return singleton as unknown as ResolvedConfigCache<T>;
}

/** Clear the shared singleton cache, if it has been created. */
export function clearResolvedConfigCache(): void {
  if (singleton !== null) singleton.clear();
}

/**
 * Derive the canonical cache key for a project root. All cache callers must key
 * through this (rather than the raw path) so symlinked/differently-cased
 * spellings of the same project collapse to one entry.
 */
export function cacheKeyForProjectRoot(projectRoot: string): string {
  return canonicalizePath(projectRoot);
}

/**
 * Read a file's modification time for staleness tracking.
 *
 * @returns the mtime in milliseconds, or `null` when the file cannot be
 *   `stat`ed (most commonly: it does not exist). `null` is a first-class
 *   recorded state — a file later appearing turns `null` into a number, which
 *   {@link backingFilesHaveChanged} treats as a change.
 */
export function backingFileMtime(absolutePath: string): number | null {
  try {
    const s = statSync(absolutePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

// True if any tracked file's current mtime differs from the recorded one. A
// missing file reads back as `null`, so existence flips (present↔absent) count
// as changes too — exactly the events that should invalidate a derived config.
function backingFilesHaveChanged(states: BackingFileStates): boolean {
  for (const [absolutePath, recorded] of states) {
    const current = backingFileMtime(absolutePath);
    if (current !== recorded) return true;
  }
  return false;
}

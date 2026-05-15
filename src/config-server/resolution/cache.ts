/**
 * R1 sprint 5 — per-`projectRoot` resolved-config cache.
 *
 * F2 freezes the resolved config for the lifetime of a `/gan` run; the
 * server-process singleton holds onto the snapshot so repeated reads
 * (e.g. multiple agents in one sprint) do not pay validation cost twice.
 * The cache is **invalidation-driven**: writes (S6) call
 * `invalidate(projectRoot)` after persisting, otherwise entries live for
 * the lifetime of the server process.
 *
 * F5 slice 3 extends the contract: every read path stats every backing
 * file before returning a cached value, so a hand-edit to an overlay or
 * a stack file bypasses the in-process invalidation path but is still
 * detected by the next read. The mtime check is unconditional on read;
 * stat is cheap (~microseconds) and the alternative is the dogfooding
 * bug F5 is closing.
 *
 *  - Cache key: canonical project root (per `determinism.canonicalizePath`).
 *  - Per-entry backing-file state: a `Map<absPath, mtimeMs | null>`
 *    captured at cache-write time. `null` records "file was absent when
 *    we computed this entry"; an appearance flips that to a number and
 *    triggers invalidation. The reverse (file disappears) is detected
 *    identically — stat throws and the state is recorded as `null`.
 *
 * Construction is via `getResolvedConfigCache()` which returns a
 * module-level singleton. Tests that need isolation can call
 * `clearResolvedConfigCache()` between cases.
 */

import { statSync } from 'node:fs';

import { canonicalizePath } from '../determinism/index.js';

/**
 * Per-backing-file state captured at cache-write time. The cache stats
 * each path on read and invalidates when any value here disagrees with
 * the current on-disk state. `null` means "file was absent when we
 * cached"; a non-null value is `mtimeMs` from `fs.statSync`.
 */
export type BackingFileStates = ReadonlyMap<string, number | null>;

/** Cache contract. The shape is intentionally narrow. */
export interface ResolvedConfigCacheLike<T> {
  /**
   * Read a cached entry by canonical project root. F5 slice 3: a read
   * that finds an entry whose recorded backing-file states disagree
   * with the current disk state drops the entry and returns
   * `undefined` (so the caller recomputes).
   */
  get(canonicalRoot: string): T | undefined;
  /**
   * Insert or replace an entry. The optional `backingFileStates`
   * argument is the snapshot of per-file state that the read path
   * compares against on subsequent calls. When omitted (test-only
   * callers that stash arbitrary values), no mtime guard is recorded
   * and the entry survives until explicit invalidation.
   */
  set(canonicalRoot: string, value: T, backingFileStates?: BackingFileStates): void;
  /** Drop a single project's cache entry (called by writes per S6). */
  invalidate(canonicalRoot: string): void;
  /** Drop every entry. Tests use this to isolate cases. */
  clear(): void;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly states: BackingFileStates;
}

/**
 * In-memory cache keyed by canonical project root. The class is generic so
 * tests can stash test-shaped objects, but the production singleton is
 * narrowed to the resolved-config JSON shape via the factory below.
 */
export class ResolvedConfigCache<T> implements ResolvedConfigCacheLike<T> {
  private readonly entries: Map<string, CacheEntry<T>>;

  constructor() {
    this.entries = new Map();
  }

  get(canonicalRoot: string): T | undefined {
    const entry = this.entries.get(canonicalRoot);
    if (entry === undefined) return undefined;
    if (backingFilesHaveChanged(entry.states)) {
      // F5 slice 3 — hand-edit detected via mtime check. Drop the
      // entry so the next read recomputes from disk.
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

  /** Diagnostic accessor for tests. */
  size(): number {
    return this.entries.size;
  }
}

let singleton: ResolvedConfigCache<unknown> | null = null;

/**
 * Return the process-wide cache singleton. Created lazily on first call.
 * Type parameter is intentionally `unknown` so callers can downcast to
 * the exact resolved-config shape; production callers go through
 * `composeResolvedConfig` which tightens the type.
 */
export function getResolvedConfigCache<T = unknown>(): ResolvedConfigCache<T> {
  if (singleton === null) {
    singleton = new ResolvedConfigCache<unknown>();
  }
  return singleton as unknown as ResolvedConfigCache<T>;
}

/** Tests-only: drop the singleton's contents. Idempotent. */
export function clearResolvedConfigCache(): void {
  if (singleton !== null) singleton.clear();
}

/**
 * Helper used by callers that already have a project-root path in any
 * form: canonicalises it before keying. Centralises the rule so a stray
 * non-canonical key cannot land in the cache.
 */
export function cacheKeyForProjectRoot(projectRoot: string): string {
  return canonicalizePath(projectRoot);
}

/**
 * Stat one path and return its `mtimeMs`, or `null` when the file is
 * absent or the stat fails for any reason. The cache treats any failure
 * mode identically — "we couldn't observe the file" — so a transient
 * permissions error invalidates the cache, which is the conservative
 * behaviour for v1.0 (worst case: an extra recompute).
 */
export function backingFileMtime(absolutePath: string): number | null {
  try {
    const s = statSync(absolutePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Return `true` when any path in `states` has a different on-disk
 * state than the one recorded. Detects all four transitions:
 *  - `present → still present, mtime advanced`
 *  - `present → absent`
 *  - `absent → present`
 *  - `absent → still absent` (no change; returns false)
 *
 * Stops on the first divergence so a small overlay change does not
 * stat the entire backing set unnecessarily.
 */
function backingFilesHaveChanged(states: BackingFileStates): boolean {
  for (const [absolutePath, recorded] of states) {
    const current = backingFileMtime(absolutePath);
    if (current !== recorded) return true;
  }
  return false;
}

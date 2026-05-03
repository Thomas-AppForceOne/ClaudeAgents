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
 * Per F2 and the C5 freshness contract:
 *  - User-side disk edits do **not** invalidate the cache. The orchestra-
 *    tor's snapshot is intentionally frozen across sprints. The next
 *    `/gan` invocation gets a fresh process and a fresh cache.
 *  - Cache key: canonical project root (per `determinism.canonicalizePath`).
 *
 * Construction is via `getResolvedConfigCache()` which returns a
 * module-level singleton. Tests that need isolation can call
 * `clearResolvedConfigCache()` between cases.
 */

import { canonicalizePath } from '../determinism/index.js';

/** Cache contract. The shape is intentionally narrow. */
export interface ResolvedConfigCacheLike<T> {
  /** Read a cached entry by canonical project root. */
  get(canonicalRoot: string): T | undefined;
  /** Insert or replace an entry. */
  set(canonicalRoot: string, value: T): void;
  /** Drop a single project's cache entry (called by writes per S6). */
  invalidate(canonicalRoot: string): void;
  /** Drop every entry. Tests use this to isolate cases. */
  clear(): void;
}

/**
 * In-memory cache keyed by canonical project root. The class is generic so
 * tests can stash test-shaped objects, but the production singleton is
 * narrowed to the resolved-config JSON shape via the factory below.
 */
export class ResolvedConfigCache<T> implements ResolvedConfigCacheLike<T> {
  private readonly entries: Map<string, T>;

  constructor() {
    this.entries = new Map();
  }

  get(canonicalRoot: string): T | undefined {
    return this.entries.get(canonicalRoot);
  }

  set(canonicalRoot: string, value: T): void {
    this.entries.set(canonicalRoot, value);
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

/**
 * Run-lock tool handlers — the MCP-callable pair for the repository's
 * single-active-run mutual-exclusion lock.
 *
 * Two wrappers, both thin: `acquireRunLockTool` forwards to the shipped
 * `acquireRunLock`, and `releaseRunLockTool` forwards to the new shared
 * `releaseRunLockAtPath`. Each tool resolves the lock path server-side from
 * `repoKey` via `resolveStoreRoot()` + `resolveRunLockPath`, so the markdown
 * orchestrator never composes that path itself — the path stays a
 * server-side derivation from a stable repo identifier.
 *
 * Why a separate path-form release lives in `src/config-server/storage/`:
 * the shipped `releaseRunLock(handle)` consumes an in-memory `RunLockHandle`,
 * but a markdown orchestrator cannot thread a JS handle between two MCP tool
 * calls. Re-deriving the lock path from `repoKey` on the release side is the
 * stateless alternative; both the handle and path forms funnel through the
 * same `releaseRunLockAtPath` to keep "one implementation per invariant".
 */
import {
  resolveRunLockPath,
  resolveStoreRoot,
} from '../storage/run-store.js';
import {
  acquireRunLock as libraryAcquireRunLock,
  releaseRunLockAtPath as libraryReleaseRunLockAtPath,
  type RunLockHandle,
} from '../storage/run-lock.js';

/**
 * Input to {@link acquireRunLockTool}.
 *
 * @property repoKey the per-repository key (from {@link
 *   computeRepoKey}/{@link resolveRunStore}). Used to derive the lock path
 *   server-side; a markdown orchestrator never composes the path itself.
 * @property runId the acquiring run's id. **Required** — a `runId`-less lock
 *   would be treated as garbage by `readRunLock` and broken by the next
 *   acquire, silently defeating the concurrent-run guard. The input schema
 *   enforces presence at the MCP boundary.
 */
export interface AcquireRunLockInput {
  repoKey: string;
  runId: string;
}

/**
 * Result of {@link acquireRunLockTool} — the resolved lock path and the
 * contents written into it.
 *
 * The shipped library returns an in-memory `RunLockHandle` (`lockPath` +
 * `contents`); the tool returns the same fields verbatim. The orchestrator
 * keeps neither field around — it later releases by `repoKey`, not by the
 * returned `lockPath` — but the fields are still surfaced for diagnostic and
 * test purposes (a unit test can `readRunLock(result.lockPath)` to verify
 * the lock is readable).
 */
export type AcquireRunLockResult = RunLockHandle;

/**
 * Acquire the repository's run lock.
 *
 * Resolves the lock path server-side as `resolveStoreRoot()` →
 * `resolveRunLockPath(storeRoot, repoKey)` — identical to the recipe the
 * release tool uses, so acquire/release are addressing one and the same file
 * by construction. Forwards to the shipped `acquireRunLock`; on a live
 * holder the library throws `InvariantViolation` (reason
 * `ConcurrentRunInProgress`) through the project's error factory, which the
 * MCP boundary surfaces verbatim.
 *
 * Side effects: creates the lock's parent directory; writes the lock file;
 * may break a stale lock (dead-pid holder) and retry. Emits stderr warnings
 * on stale-break — the default warn sink.
 *
 * @param input see {@link AcquireRunLockInput}.
 * @returns the {@link AcquireRunLockResult} (`lockPath` + `contents`).
 * @throws `InvariantViolation` (`ConcurrentRunInProgress`) when the lock is
 *   held by a live pid — propagated from the library through the F2 error
 *   factory.
 */
export function acquireRunLockTool(
  input: AcquireRunLockInput,
): AcquireRunLockResult {
  const lockPath = resolveRunLockPath(resolveStoreRoot(), input.repoKey);
  return libraryAcquireRunLock({ lockPath, runId: input.runId });
}

/**
 * Input to {@link releaseRunLockTool}.
 *
 * @property repoKey the per-repository key the lock path is derived from.
 *   No `runId` is needed here — release deletes the lock file regardless of
 *   who acquired it (the acquire-side `runId` was written into the lock
 *   contents only for diagnostic purposes; only the path identifies the
 *   lock).
 */
export interface ReleaseRunLockInput {
  repoKey: string;
}

/**
 * Result of {@link releaseRunLockTool} — the resolved lock path the release
 * targeted.
 *
 * The result is informational: release is idempotent (a missing file is not
 * an error), so the value carries no success/failure distinction. The path
 * is returned mostly for test/diagnostic use, mirroring the acquire side.
 */
export interface ReleaseRunLockResult {
  lockPath: string;
}

/**
 * Release the repository's run lock by `repoKey`.
 *
 * Re-derives the lock path from `repoKey` exactly as
 * {@link acquireRunLockTool} did, then forwards to the shared
 * `releaseRunLockAtPath` helper — one delete implementation behind both the
 * handle-taking library call and this path-taking tool.
 *
 * Idempotent: an already-missing lock (released, never acquired, or broken
 * by another acquirer) is not an error.
 *
 * @param input see {@link ReleaseRunLockInput}.
 * @returns `{ lockPath }` — the path the release targeted.
 */
export function releaseRunLockTool(
  input: ReleaseRunLockInput,
): ReleaseRunLockResult {
  const lockPath = resolveRunLockPath(resolveStoreRoot(), input.repoKey);
  libraryReleaseRunLockAtPath(lockPath);
  return { lockPath };
}

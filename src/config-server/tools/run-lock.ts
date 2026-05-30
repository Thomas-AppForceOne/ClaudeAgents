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
import { resolveRunLockPath, resolveStoreRoot } from '../storage/run-store.js';
import {
  acquireRunLock as libraryAcquireRunLock,
  readRunLock as libraryReadRunLock,
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
 * contents written into it, plus the F2 mutation indicator.
 *
 * The shipped library returns an in-memory `RunLockHandle` (`lockPath` +
 * `contents`); the tool returns the same fields verbatim and adds `mutated`
 * as a sibling. The orchestrator keeps neither lock field around — it later
 * releases by `repoKey`, not by the returned `lockPath` — but the fields are
 * still surfaced for diagnostic and test purposes (a unit test can
 * `readRunLock(result.lockPath)` to verify the lock is readable).
 *
 * @property mutated always `true`: the library only returns on a successful
 *   acquire (it created the lock file, including the stale-break re-acquire
 *   path) and throws otherwise, so a returned handle always means durable
 *   state changed. Lets the orchestrator OR this flag in uniformly with the
 *   other R7 write tools per the F2 mutation-indicator contract.
 */
export type AcquireRunLockResult = RunLockHandle & { mutated: true };

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
export function acquireRunLockTool(input: AcquireRunLockInput): AcquireRunLockResult {
  const lockPath = resolveRunLockPath(resolveStoreRoot(), input.repoKey);
  // A returned handle means the library created the lock (first-try or
  // stale-break re-acquire); the throw path never reaches here. So the F2
  // mutation indicator is unconditionally true on this surface.
  return { ...libraryAcquireRunLock({ lockPath, runId: input.runId }), mutated: true };
}

/**
 * Input to {@link releaseRunLockTool}.
 *
 * @property repoKey the per-repository key the lock path is derived from.
 * @property runId the acquiring run's id. **Required** for identity
 *   verification — release reads the on-disk lock contents and only unlinks
 *   when the recorded `runId` matches the caller's; a mismatch is a silent
 *   no-op so a late, stale tear-down from a superseded run cannot delete the
 *   live successor's lock. The acquire side already returns `runId` in the
 *   handle and `GAN_RUN_ID` is exported into every spawned sub-agent's env,
 *   so threading the value through release is free at every call site.
 */
export interface ReleaseRunLockInput {
  repoKey: string;
  runId: string;
}

/**
 * Result of {@link releaseRunLockTool} — the resolved lock path the release
 * targeted, plus the F2 mutation indicator.
 *
 * The `lockPath` is informational: release is idempotent (a missing file is
 * not an error), so the path alone carries no success/failure distinction. The
 * path is returned mostly for test/diagnostic use, mirroring the acquire side.
 *
 * @property mutated `true` when a lock file was actually removed; `false` for
 *   the documented idempotent no-op — the lock was already gone, or the
 *   on-disk holder's `runId` did not match the caller's (a superseded run's
 *   late tear-down) so the unlink was deliberately skipped. This is the real
 *   "did the release change durable state?" signal the F2 contract asks for.
 */
export interface ReleaseRunLockResult {
  lockPath: string;
  mutated: boolean;
}

/**
 * Release the repository's run lock by `repoKey`, gated on `runId` identity.
 *
 * Re-derives the lock path from `repoKey` exactly as
 * {@link acquireRunLockTool} did, reads the on-disk lock's contents, and
 * only forwards to the shared `releaseRunLockAtPath` helper when the
 * recorded holder's `runId` equals the caller's `input.runId`. A mismatch
 * (or an unreadable / missing lock) is a silent no-op — the SKILL.md
 * idempotency contract (a graceful-then-error overlap may double-release,
 * a successor lock must survive a late stale release from a superseded run)
 * is preserved by making the no-op the safe default rather than an error.
 *
 * Idempotent: an already-missing lock (released, never acquired, or broken
 * by another acquirer) is not an error.
 *
 * @param input see {@link ReleaseRunLockInput}.
 * @returns `{ lockPath, mutated }` — the path the release targeted (reported
 *   regardless of whether the unlink fired, so a test or diagnostic call can
 *   compare it to {@link AcquireRunLockResult.lockPath}) and whether a lock
 *   file was actually removed.
 */
export function releaseRunLockTool(input: ReleaseRunLockInput): ReleaseRunLockResult {
  const lockPath = resolveRunLockPath(resolveStoreRoot(), input.repoKey);
  const holder = libraryReadRunLock(lockPath);
  // Only the identity-matched branch can mutate; an unmatched / unreadable /
  // missing lock is the documented idempotent no-op (mutated stays false).
  // The shared path-form release reports whether it actually unlinked, so a
  // lock that vanished between the read and the unlink also reads as no-op.
  let mutated = false;
  if (holder !== undefined && holder.runId === input.runId) {
    mutated = libraryReleaseRunLockAtPath(lockPath);
  }
  return { lockPath, mutated };
}

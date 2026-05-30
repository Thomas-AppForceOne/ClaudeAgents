/**
 * Run-lock tool tests — round-trip-by-key, live-holder refusal with
 * ConcurrentRunInProgress, the acquired lock readable by readRunLock, idempotent
 * release, and tool-vs-library parity for the new release-by-key path.
 *
 * The store-root is pointed at a scratch directory via GAN_RUNS_DATA so the
 * lock file never lands under a developer's real central store; vi.stubEnv
 * scrubs any inherited shell value at every `beforeEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigServerError } from '../../../src/config-server/errors.js';
import {
  readRunLock,
  releaseRunLockAtPath as libraryReleaseRunLockAtPath,
} from '../../../src/config-server/storage/run-lock.js';
import {
  resolveRunLockPath,
  resolveStoreRoot,
} from '../../../src/config-server/storage/run-store.js';
import {
  acquireRunLockTool,
  releaseRunLockTool,
} from '../../../src/config-server/tools/run-lock.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-run-lock-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('run-lock tools — acquire/release by key', () => {
  // A synthetic repoKey is enough — the lock tools derive the path entirely
  // from `repoKey` plus the resolved storeRoot, and never read the worktree.
  // Using a fixed key keeps the assertions simple and lets each test isolate
  // its lock file under a fresh storeRoot.
  const repoKey = 'r7-test-repo-deadbeef0000';
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = makeTmp('r7-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('acquireRunLock writes the lock file; readRunLock returns a record whose runId matches', () => {
    const runId = '20260522T180000-acq1';
    const result = acquireRunLockTool({ repoKey, runId });
    expect(existsSync(result.lockPath)).toBe(true);
    // A returned handle always means the lock was created, so the F2 mutation
    // indicator is unconditionally true on this surface.
    expect(result.mutated).toBe(true);

    // Companion-check: the written lock is readable (a runId-less lock would
    // be treated as garbage by readRunLock and silently broken by the next
    // acquire — the explicit readback guards against that regression).
    const contents = readRunLock(result.lockPath);
    expect(contents).toBeDefined();
    expect(contents?.runId).toBe(runId);
  });

  it('round-trip-by-key: acquire → release({ repoKey, runId }) → re-acquire succeeds', () => {
    const runId = '20260522T180000-rt01';
    const first = acquireRunLockTool({ repoKey, runId });
    expect(existsSync(first.lockPath)).toBe(true);

    // Release by repoKey + runId — no JS handle threaded between the two
    // calls; the runId proves holder identity so a delayed release from a
    // superseded run cannot delete the live successor's lock. This is the
    // M1 stranding fix plus the C-1/I-006 holder-proof tightening.
    const released = releaseRunLockTool({ repoKey, runId });
    expect(released.lockPath).toBe(first.lockPath);
    // A real unlink changed durable state: the F2 indicator is true.
    expect(released.mutated).toBe(true);
    expect(existsSync(first.lockPath)).toBe(false);

    // Immediate re-acquire on the same repoKey must succeed cleanly.
    const second = acquireRunLockTool({ repoKey, runId: '20260522T180000-rt02' });
    expect(existsSync(second.lockPath)).toBe(true);
  });

  it('live holder: second acquire on the same repoKey is refused with ConcurrentRunInProgress', () => {
    // The first acquire records the current pid, which is necessarily alive
    // during the test. The second acquire therefore hits the live-holder
    // branch of the library's `acquireRunLock` and throws — the F2 error
    // factory wraps it as InvariantViolation(reason=ConcurrentRunInProgress)
    // with shell remediation in the message.
    const runId = '20260522T180000-liv1';
    acquireRunLockTool({ repoKey, runId });

    let caught: unknown;
    try {
      acquireRunLockTool({ repoKey, runId: '20260522T180000-liv2' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    const err = caught as ConfigServerError;
    expect(err.code).toBe('InvariantViolation');
    // The reason is part of the structured payload, not the typed surface.
    expect((err as unknown as { reason: string }).reason).toBe('ConcurrentRunInProgress');
    // The remediation names a shell command (kill <pid>) per the F4
    // user-facing error-text discipline.
    expect(err.message).toMatch(/kill \d+/);
  });

  it('release is idempotent: a second release after the lock is already gone does not throw', () => {
    const runId = '20260522T180000-idem';
    acquireRunLockTool({ repoKey, runId });
    const first = releaseRunLockTool({ repoKey, runId });
    expect(first.mutated).toBe(true);
    // Already gone; the second release must be a no-op rather than a throw,
    // because the orchestrator's exit-path handlers may issue release on a
    // path the lock was already released on (graceful + abort overlap).
    let second: ReturnType<typeof releaseRunLockTool> | undefined;
    expect(() => {
      second = releaseRunLockTool({ repoKey, runId });
    }).not.toThrow();
    // The idempotent no-op removed nothing, so the F2 indicator is false —
    // the signal an orchestrator OR's in without re-snapshotting on a no-op.
    expect(second?.mutated).toBe(false);
  });

  it('release on a lock that was never acquired is also a no-op', () => {
    // Safety net: a buggy orchestrator could call release before any acquire
    // (e.g. an error path that races the acquire). The tool must not throw.
    let result: ReturnType<typeof releaseRunLockTool> | undefined;
    expect(() => {
      result = releaseRunLockTool({ repoKey, runId: '20260522T180000-naq1' });
    }).not.toThrow();
    // Nothing was removed; mutated is false for the never-acquired no-op.
    expect(result?.mutated).toBe(false);
  });

  it('tool-vs-library parity: releaseRunLockTool funnels through the shared releaseRunLockAtPath', () => {
    // Acquire via the tool, release via a direct library import of the shared
    // path-form release: both paths must address the same lock file (the
    // round trip works regardless of which side issued the delete). The
    // library-form release does not gate on identity — the identity check
    // is the *tool*'s responsibility (C-1/I-006), so the library call is
    // used here as the equivalent of an unconditional unlink to prove the
    // path computation matches.
    const runId = '20260522T180000-prty';
    const acquired = acquireRunLockTool({ repoKey, runId });
    expect(existsSync(acquired.lockPath)).toBe(true);

    // Compute the path the same way the tool does, then call the library
    // function directly — the shared "one implementation per invariant" path.
    const expectedLockPath = resolveRunLockPath(resolveStoreRoot(), repoKey);
    expect(expectedLockPath).toBe(acquired.lockPath);
    libraryReleaseRunLockAtPath(expectedLockPath);
    expect(existsSync(expectedLockPath)).toBe(false);

    // And a fresh acquire on the same key still succeeds — the library
    // release left the lock fully cleared, as the tool's release would.
    const reacquired = acquireRunLockTool({ repoKey, runId: '20260522T180000-prt2' });
    expect(existsSync(reacquired.lockPath)).toBe(true);
  });

  it('release with a mismatched runId is a silent no-op: the on-disk lock survives', () => {
    // I-006 fix: a delayed release from a crashed-then-superseded run only
    // knows `repoKey`; without the identity guard it would unlink the
    // *successor*'s live lock and let a third concurrent run acquire,
    // breaking the single-active-run invariant. The tool reads the on-disk
    // contents and returns silently when the runIds differ.
    const heldRunId = '20260522T180000-hold';
    const acquired = acquireRunLockTool({ repoKey, runId: heldRunId });
    expect(existsSync(acquired.lockPath)).toBe(true);

    // The "stale" release names a different runId — the kind a delayed,
    // superseded run would carry. The lock must NOT be unlinked.
    const released = releaseRunLockTool({ repoKey, runId: '20260522T180000-stal' });
    expect(released.lockPath).toBe(acquired.lockPath);
    // The identity-mismatch no-op unlinked nothing, so mutated is false even
    // though a lock file is present on disk.
    expect(released.mutated).toBe(false);
    expect(existsSync(acquired.lockPath)).toBe(true);

    // And the recorded holder is still the original one — the no-op did
    // not corrupt the contents either.
    const contents = readRunLock(acquired.lockPath);
    expect(contents?.runId).toBe(heldRunId);
  });

  it('release with the matching runId succeeds and unlinks the lock file', () => {
    // The positive side of the identity check: when the runIds agree, the
    // tool forwards to `releaseRunLockAtPath` exactly as before. Pairs with
    // the mismatch test above so a regression that always-unlinks or
    // never-unlinks both flunk one test each.
    const runId = '20260522T180000-mtch';
    const acquired = acquireRunLockTool({ repoKey, runId });
    expect(existsSync(acquired.lockPath)).toBe(true);

    const released = releaseRunLockTool({ repoKey, runId });
    expect(released.lockPath).toBe(acquired.lockPath);
    // Identity matched and the file was unlinked, so mutated is true.
    expect(released.mutated).toBe(true);
    expect(existsSync(acquired.lockPath)).toBe(false);
  });

  it('release against an unreadable / garbage lock file is also a silent no-op (no unlink)', () => {
    // `readRunLock` returns `undefined` for an unreadable / shapeless lock.
    // The identity gate must treat that the same way it treats a mismatch:
    // do not unlink. (The acquire side breaks-then-retries an unreadable
    // lock; release does not need to participate in that recovery.)
    const runId = '20260522T180000-grbg';
    const lockPath = resolveRunLockPath(resolveStoreRoot(), repoKey);
    // Hand-craft a garbage lock — present on disk, but lacks the runId/pid
    // fields readRunLock requires. The next acquire would break it; the
    // tool's release must leave it alone.
    const repoStoreDir = path.dirname(lockPath);
    mkdirSync(repoStoreDir, { recursive: true });
    writeFileSync(lockPath, '{}', { encoding: 'utf8' });
    expect(existsSync(lockPath)).toBe(true);
    expect(readRunLock(lockPath)).toBeUndefined();

    releaseRunLockTool({ repoKey, runId });
    // The garbage file is still on disk — the tool refused to delete what it
    // could not prove identity over. (This is a stricter contract than the
    // pre-fix "always unlink" path, and is the bedrock of the I-006 fix.)
    expect(existsSync(lockPath)).toBe(true);
    // Cleanup so the test does not poison other tests' acquire paths.
    libraryReleaseRunLockAtPath(lockPath);
  });


  it('tool-vs-library parity: acquireRunLockTool dispatches through the shipped acquire (lock paths match)', () => {
    // The tool computes the lock path the same way the release tool does
    // (resolveStoreRoot + resolveRunLockPath); the library `acquireRunLock`
    // takes that path as an input. Asserting the tool's returned `lockPath`
    // equals the path the same path-resolver pair produces pins that the
    // tool layer adds no second path derivation behind the lock.
    const runId = '20260522T180000-acq2';
    const acquired = acquireRunLockTool({ repoKey, runId });
    const directPath = resolveRunLockPath(resolveStoreRoot(), repoKey);
    expect(acquired.lockPath).toBe(directPath);
  });
});

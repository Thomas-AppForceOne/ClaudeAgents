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

  it('the tool return surfaces no holder pid/hostname (only lockPath, runId, startedAt, mutated)', () => {
    // I-039: the library handle carries the holder's pid + hostname (the
    // long-lived config-server process), and a tool return is never run
    // through input-only redaction — so those two server-process facts must
    // not appear on the client-facing return shape. The on-disk lock still
    // records them (a diagnostic test reads them via readRunLock); only the
    // tool boundary projects them away.
    const runId = '20260522T180000-redz';
    const result = acquireRunLockTool({ repoKey, runId });
    expect(Object.keys(result).sort()).toEqual(
      ['lockPath', 'mutated', 'runId', 'startedAt'].sort(),
    );
    expect(result).not.toHaveProperty('pid');
    expect(result).not.toHaveProperty('hostname');
    expect(result).not.toHaveProperty('contents');
    expect(result.runId).toBe(runId);
    // The redacted fields are still durably recorded on disk — only the
    // return shape hides them.
    const onDisk = readRunLock(result.lockPath);
    expect(typeof onDisk?.pid).toBe('number');
    expect(typeof onDisk?.hostname).toBe('string');
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

  it('recover acquire — live holder whose runId matches recoverTargetRunId throws StrandedSelfLock with lockPath + rm escape', () => {
    // I-005 / AC 30 branch 1 of 3. The recover flow passes the run-id it is
    // trying to recover via `recoverTargetRunId`. When the live holder's
    // recorded `runId` matches, the lock is "stranded self": the pid in the
    // lock is the long-lived config server, not a competing run, so the
    // generic "kill <pid>" guidance would point the user at the framework
    // process every other run on the machine depends on. The tool must
    // therefore surface the distinct `StrandedSelfLock` reason whose message
    // names the actual lock path and the `rm <lockPath>` manual-friction
    // escape — distinct from `ConcurrentRunInProgress`.
    const targetRunId = '20260522T180000-srec';
    // Seed the lock as if the recover-target run is already the recorded
    // holder; the on-disk pid is `process.pid`, necessarily alive during the
    // test, so the live-holder branch fires deterministically.
    acquireRunLockTool({ repoKey, runId: targetRunId });

    let caught: unknown;
    try {
      acquireRunLockTool({
        repoKey,
        runId: targetRunId,
        recoverTargetRunId: targetRunId,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    const err = caught as ConfigServerError;
    expect(err.code).toBe('InvariantViolation');
    expect((err as unknown as { reason: string }).reason).toBe('StrandedSelfLock');
    // The message must name the actual lock path so the user can find the
    // file the `rm` escape targets. The tool re-derives the path the same
    // way the acquire side did; we reach into the structured `path` field to
    // assert it points at the same on-disk lock.
    const lockPath = (err as unknown as { path: string }).path;
    expect(lockPath).toBe(resolveRunLockPath(resolveStoreRoot(), repoKey));
    expect(err.message).toContain(lockPath);
    // The `rm <lockPath>` escape is the recover-specific manual-friction
    // remediation; it must appear verbatim in the message so a reader is
    // not left guessing how to clear the lock.
    expect(err.message).toContain(`rm ${lockPath}`);
  });

  it('recover acquire — live holder whose runId differs from recoverTargetRunId still throws ConcurrentRunInProgress', () => {
    // I-005 / AC 30 branch 2 of 3. The `recoverTargetRunId` knob is narrow:
    // it only re-shapes the message when the holder's `runId` *matches* the
    // recover target. A different-runId live-pid lock is a genuine
    // concurrent run, regardless of whether the caller is in a recover
    // flow, and must still surface the unchanged `ConcurrentRunInProgress`
    // refusal — otherwise the recover path would silently swallow the
    // cross-run conflict.
    const heldRunId = '20260522T180000-held';
    const recoverTarget = '20260522T180000-rec2';
    acquireRunLockTool({ repoKey, runId: heldRunId });

    let caught: unknown;
    try {
      acquireRunLockTool({
        repoKey,
        runId: recoverTarget,
        recoverTargetRunId: recoverTarget,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    const err = caught as ConfigServerError;
    expect(err.code).toBe('InvariantViolation');
    expect((err as unknown as { reason: string }).reason).toBe('ConcurrentRunInProgress');
    // The generic refusal still carries its shell remediation (kill <pid>)
    // — proves the recover-knob did not weaken the unchanged branch.
    expect(err.message).toMatch(/kill \d+/);
  });

  it('recover acquire — dead-pid lock silently stale-breaks and acquires (unchanged behaviour)', () => {
    // I-005 / AC 30 branch 3 of 3. A dead-pid lock is always stale-broken
    // by the regular lock-acquisition path; the `recoverTargetRunId` knob
    // does not change that, because a dead pid cannot be either a stranded
    // self-lock (no live config server) or a competing run (no live
    // acquirer). We forge a lock file on disk with a never-live pid (the
    // `DEAD_PID` constant the sibling recovery-serialization test uses for
    // the same purpose) and confirm the acquire silently breaks it, emits
    // a stale-break notice through the warn sink, and writes the
    // recover-target run as the new holder.
    const DEAD_PID = 2147483646;
    const lockPath = resolveRunLockPath(resolveStoreRoot(), repoKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        runId: '20260522T170000-dead',
        pid: DEAD_PID,
        startedAt: '2026-05-22T17:00:00Z',
        hostname: 'old',
      }) + '\n',
      'utf8',
    );

    const recoverTarget = '20260522T180000-srvd';
    const warnings: string[] = [];
    const result = acquireRunLockTool(
      {
        repoKey,
        runId: recoverTarget,
        recoverTargetRunId: recoverTarget,
      },
      { warn: (line) => warnings.push(line) },
    );

    // The lock now records the recover-target run, not the forged dead one.
    expect(existsSync(result.lockPath)).toBe(true);
    expect(result.runId).toBe(recoverTarget);
    const contents = readRunLock(result.lockPath);
    expect(contents?.runId).toBe(recoverTarget);
    expect(contents?.pid).toBe(process.pid);
    // The stale-break notice reached the warn sink (not stderr), with the
    // dead-pid run-id named so a log scanner can correlate it.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/stale/i);
    expect(warnings[0]).toContain('20260522T170000-dead');
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


  it('routes a stale-break warning through the supplied warn sink, not raw stderr', () => {
    // I-031: the tool forwards a `warn` sink to the library so stale-break
    // notices join the structured stream the dispatch wires to getLogger().
    // Plant a garbage (unreadable) lock so the library's break-then-retry
    // path fires deterministically without needing pid-liveness control, then
    // assert the supplied sink — not stderr — received the notice.
    const lockPath = resolveRunLockPath(resolveStoreRoot(), repoKey);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '{}', { encoding: 'utf8' });

    const warnings: string[] = [];
    const result = acquireRunLockTool(
      { repoKey, runId: '20260522T180000-warn' },
      { warn: (line) => warnings.push(line) },
    );
    // The lock was re-acquired after breaking the garbage one.
    expect(existsSync(result.lockPath)).toBe(true);
    // Exactly the stale-break notice reached the sink.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unreadable run\.lock/);
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

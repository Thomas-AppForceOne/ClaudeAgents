/**
 * F7 slice 4 — one-active-run-per-repo serialization lock, re-anchored to the
 * central store (over O2 §8).
 *
 * O2's serialization lock was anchored on `<projectRoot>/.gan-state/run.lock`.
 * Because two linked worktrees of one repo each resolve their own
 * `<projectRoot>` to the worktree toplevel, that lock would NOT serialize
 * concurrent runs across worktrees of the same repo. F7 re-anchors it to the
 * central, repo-keyed store at `<store-root>/<repo-key>/run.lock` (slice-1
 * {@link resolveRunLockPath}). All linked worktrees of a repo key to the same
 * `<repo-key>`, so they contend on the SAME lock file — one active `/gan` run
 * per repo, repo-wide.
 *
 * Mechanism (the portable POSIX advisory-lock equivalent). The exclusive guard
 * is an atomic exclusive-create on the lock path: the contents
 * `{ runId, pid, startedAt, hostname }` are first written to a sibling temp file
 * and then linked into place with `O_EXCL` (`fs.linkSync`), so only one of N
 * racing acquirers can win — there is no window in which two processes both
 * believe they hold the lock. (`flock(LOCK_EX|LOCK_NB)` is unavailable as a
 * Node syscall and the `flock` binary is not present on every supported
 * platform; the exclusive-create-on-rename discipline gives the same
 * mutual-exclusion contract O2 §8 specifies, with the documented
 * `{ runId, pid, startedAt, hostname }` contents written atomically.) On
 * release the lock file is unlinked.
 *
 * Contention -> holder liveness. When the create fails because the lock already
 * exists, the holder's `pid` is probed for liveness (`kill -0`, surfaced here
 * via the injectable {@link IsAlive} seam defaulting to `process.kill(pid, 0)`).
 * A LIVE holder => hard refuse with a structured `ConcurrentRunInProgress`
 * error naming the holder's `runId`, `pid`, and `startedAt`. A DEAD holder
 * (stale lock from a hard-killed previous run) => break the stale lock, warn,
 * and acquire fresh.
 *
 * Subprocess / determinism safety: this module spawns no subprocess at all (it
 * uses Node fs primitives + `process.kill(pid, 0)`), so there is no shell line
 * for any untrusted value to reach. The liveness probe takes a numeric pid, not
 * a string; the injectable seam exists purely so the dead/alive branches are
 * unit-testable without a real process. Nothing here reads or writes the
 * module-state store, `.claude/gan/`, or `.gan-cache/`.
 */

import { linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createError } from '../errors.js';
import { readJsonObjectFile } from './json-read.js';

/** Parsed contents of the run lock file. */
export interface RunLockContents {
  /** The run id holding the lock. */
  runId: string;
  /** The pid of the process holding the lock. */
  pid: number;
  /** ISO-8601 UTC timestamp the lock was acquired at. */
  startedAt: string;
  /** Hostname the holder runs on (advisory; not used for cross-host checks). */
  hostname: string;
}

/**
 * Liveness probe seam. Returns `true` when a process with `pid` is alive.
 * Defaults to `process.kill(pid, 0)` — sending signal `0` performs the
 * permission/existence check without delivering a signal (the `kill -0`
 * idiom). Injected in tests so the dead-holder (stale-lock) branch is
 * exercisable deterministically.
 */
export type IsAlive = (pid: number) => boolean;

/** Default liveness probe: `process.kill(pid, 0)` — the `kill -0` idiom. */
export const defaultIsAlive: IsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process (dead). EPERM => exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A held lock handle — pass to {@link releaseRunLock} to release it. */
export interface RunLockHandle {
  /** The lock file path that was created. */
  lockPath: string;
  /** The contents written into the lock. */
  contents: RunLockContents;
}

/** Options for {@link acquireRunLock}. */
export interface AcquireRunLockOptions {
  /** The lock path — pass slice-1 `resolveRunLockPath(storeRoot, repoKey)`. */
  lockPath: string;
  /** The acquiring run's id. */
  runId: string;
  /** The acquiring process pid. Defaults to `process.pid`. */
  pid?: number;
  /** ISO-8601 UTC start time. Defaults to `new Date().toISOString()`. */
  startedAt?: string;
  /** Hostname. Defaults to `os.hostname()`. */
  hostname?: string;
  /** Liveness probe seam (tests). Defaults to {@link defaultIsAlive}. */
  isAlive?: IsAlive;
  /** Sink for the stale-lock-broken warning. Defaults to `console.error`. */
  warn?: (line: string) => void;
}

/** Read and parse the lock file, or `undefined` if absent / unparseable. */
export function readRunLock(lockPath: string): RunLockContents | undefined {
  const obj = readJsonObjectFile(lockPath);
  if (obj === undefined) return undefined;
  const runId = typeof obj.runId === 'string' ? obj.runId : undefined;
  const pid = typeof obj.pid === 'number' ? obj.pid : undefined;
  if (runId === undefined || pid === undefined) return undefined;
  return {
    runId,
    pid,
    startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : '',
    hostname: typeof obj.hostname === 'string' ? obj.hostname : '',
  };
}

/**
 * Acquire the repo-wide run lock at `lockPath` exclusively.
 *
 * On success returns a {@link RunLockHandle}. On contention with a LIVE holder,
 * throws a structured `ConcurrentRunInProgress` error (mapped onto F2's
 * `InvariantViolation` code with a `reason: 'ConcurrentRunInProgress'` field
 * and the holder's `runId`/`pid`/`startedAt`). A stale lock (dead holder) is
 * broken with a warning and acquisition proceeds.
 *
 * @throws ConfigServerError when a live holder already holds the lock.
 */
export function acquireRunLock(opts: AcquireRunLockOptions): RunLockHandle {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const contents: RunLockContents = {
    runId: opts.runId,
    pid: opts.pid ?? process.pid,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    hostname: opts.hostname ?? os.hostname(),
  };

  mkdirSync(path.dirname(opts.lockPath), { recursive: true });

  // Two attempts at most: the second only runs after a confirmed stale-lock
  // break, so a live holder can never be silently overwritten.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(opts.lockPath, contents)) {
      return { lockPath: opts.lockPath, contents };
    }

    // The lock already exists. Inspect the holder.
    const holder = readRunLock(opts.lockPath);
    if (holder === undefined) {
      // Unparseable/partial lock from a crashed acquirer; treat as stale.
      breakStaleLock(opts.lockPath);
      warn(`Broke an unreadable run.lock at ${opts.lockPath}; acquiring fresh.`);
      continue;
    }

    if (isAlive(holder.pid)) {
      throw createError('InvariantViolation', {
        reason: 'ConcurrentRunInProgress',
        path: opts.lockPath,
        field: 'run.lock',
        runId: holder.runId,
        pid: holder.pid,
        startedAt: holder.startedAt,
        message:
          `Another /gan run is already active for this repository: run '${holder.runId}' ` +
          `(pid ${holder.pid}, started ${holder.startedAt}). Only one run per repository may ` +
          `be active at a time, across all of its worktrees. Wait for the other run to ` +
          `finish, or stop it (kill ${holder.pid}) if it is stuck, then run again.`,
        remediation:
          `Wait for run '${holder.runId}' to finish, or run 'kill ${holder.pid}' if it is ` +
          `stuck, then re-run.`,
      });
    }

    // Dead holder => stale lock. Break it, warn, and retry the create.
    breakStaleLock(opts.lockPath);
    warn(
      `Broke a stale run.lock at ${opts.lockPath} held by run '${holder.runId}' ` +
        `(pid ${holder.pid} is no longer alive); acquiring fresh.`,
    );
  }

  // Both attempts lost a race against another acquirer; surface as contention.
  const holder = readRunLock(opts.lockPath);
  throw createError('InvariantViolation', {
    reason: 'ConcurrentRunInProgress',
    path: opts.lockPath,
    field: 'run.lock',
    runId: holder?.runId,
    pid: holder?.pid,
    message:
      `Could not acquire the run lock at ${opts.lockPath}; another /gan run for this ` +
      `repository acquired it concurrently. Wait for it to finish, then run again.`,
  });
}

/**
 * Release a previously-acquired lock by unlinking the file. Idempotent and
 * best-effort: a missing file (already released, or broken as stale by another
 * acquirer) is not an error.
 */
export function releaseRunLock(handle: RunLockHandle): void {
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // Already gone; nothing to release.
  }
}

/**
 * Atomically create the lock file with `contents`, failing if it already
 * exists. Writes to a sibling temp file then `link`s it into place under
 * `O_EXCL` semantics — `linkSync` fails with `EEXIST` when the target exists,
 * giving us exclusive create even on filesystems where `writeFileSync(...,
 * { flag: 'wx' })` would race. Returns `true` on a clean acquire, `false` when
 * the lock already existed.
 */
function tryCreateLock(lockPath: string, contents: RunLockContents): boolean {
  const tmp = `${lockPath}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  writeFileSync(tmp, JSON.stringify(contents) + '\n', { encoding: 'utf8' });
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}

/** Remove a stale lock file, ignoring a concurrent removal. */
function breakStaleLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Another acquirer may have removed it first; fine.
  }
}

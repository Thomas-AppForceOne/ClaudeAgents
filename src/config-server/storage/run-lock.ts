

/**
 * Single-active-run mutual exclusion for a repository.
 *
 * At most one `/gan` run may be active per repository at a time, across all of
 * its worktrees. That invariant is enforced by a `run.lock` file in the repo's
 * central store, created via an atomic `link(2)` so two processes racing to
 * acquire it cannot both win — `link` fails with `EEXIST` for the loser.
 *
 * The lock is *self-healing* against crashed holders: a lock whose recorded pid
 * is no longer alive (or whose contents are unreadable) is "stale" and is
 * broken and re-acquired, so a process that died without releasing its lock
 * does not wedge the repository forever. A lock held by a *live* process is
 * honoured and acquisition throws.
 */
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createError } from '../errors.js';
import { readJsonObjectFile } from './json-read.js';

/**
 * The persisted contents of a `run.lock`, identifying the holder.
 *
 * @property runId the run that holds the lock.
 * @property pid the holder's process id (probed for liveness).
 * @property startedAt ISO-8601 time the lock was taken (informational, shown in
 *   conflict messages).
 * @property hostname the holder's host (informational).
 */
export interface RunLockContents {

  runId: string;

  pid: number;

  startedAt: string;

  hostname: string;
}

/** Liveness probe: returns whether `pid` is a running process. Injectable so
 * tests can simulate live vs. dead holders. */
export type IsAlive = (pid: number) => boolean;

/**
 * Production {@link IsAlive}: probes via signal 0 (`process.kill(pid, 0)`),
 * which checks existence without delivering a signal.
 *
 * Returns `false` for non-positive/non-integer pids up front. An `EPERM` from
 * the probe is treated as ALIVE: the process exists but is owned by another
 * user, so we may not signal it — but it is running, which is what matters for
 * the lock. Any other error (notably `ESRCH`, no such process) means dead.
 */
export const defaultIsAlive: IsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => process exists but is not ours to signal: still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * A held lock, returned by {@link acquireRunLock} and passed to
 * {@link releaseRunLock}.
 *
 * @property lockPath the lock file path.
 * @property contents the contents written into it.
 */
export interface RunLockHandle {

  lockPath: string;

  contents: RunLockContents;
}

/**
 * Options for {@link acquireRunLock}.
 *
 * @property lockPath where to create the lock.
 * @property runId the acquiring run's id, written into the lock.
 * @property pid the acquiring pid; defaults to `process.pid`.
 * @property startedAt acquisition time; defaults to now (ISO-8601).
 * @property hostname the acquiring host; defaults to `os.hostname()`.
 * @property isAlive liveness probe for an existing holder; defaults to
 *   {@link defaultIsAlive}.
 * @property warn sink for stale-lock-broken notices; defaults to `stderr`.
 */
export interface AcquireRunLockOptions {

  lockPath: string;

  runId: string;

  pid?: number;

  startedAt?: string;

  hostname?: string;

  isAlive?: IsAlive;

  warn?: (line: string) => void;
}

/**
 * Read and minimally validate a `run.lock`.
 *
 * @param lockPath the lock file path.
 * @returns the parsed {@link RunLockContents}, or `undefined` when the file is
 *   absent or unreadable, or lacks a string `runId` and numeric `pid` (the two
 *   fields that make a lock meaningful). `startedAt`/`hostname` default to empty
 *   strings when missing — they are informational only. Never throws.
 */
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
 * Acquire the repository's run lock, breaking a stale one if needed.
 *
 * Tries to create the lock atomically; on contention it inspects the current
 * holder. An unreadable lock or a holder whose pid is dead is broken and
 * acquisition retried (once). A live holder makes acquisition fail.
 *
 * Side effects: creates the lock's parent directory and the lock file; may
 * delete (break) a stale lock; emits warnings via `opts.warn` when it breaks a
 * lock.
 *
 * @param opts see {@link AcquireRunLockOptions}.
 * @returns a {@link RunLockHandle} for the held lock.
 * @throws `ConfigServerError('InvariantViolation', reason:
 *   'ConcurrentRunInProgress')` when the lock is held by a live run, or when it
 *   could not be acquired after breaking a stale one (lost a concurrent race).
 *   The message names the conflicting run/pid and how to resolve it.
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

  // Two attempts: the first may find a stale lock and break it; the second
  // then re-creates it. More than one retry is unnecessary — a second loss is
  // a genuine concurrent acquirer, handled as a hard conflict after the loop.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(opts.lockPath, contents)) {
      return { lockPath: opts.lockPath, contents };
    }

    const holder = readRunLock(opts.lockPath);
    if (holder === undefined) {
      // Lock exists but is unreadable/garbage: treat as stale, break, retry.
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

    // Holder's process is dead: the previous run crashed without releasing.
    // Break the abandoned lock and retry rather than wedging the repo forever.
    breakStaleLock(opts.lockPath);
    warn(
      `Broke a stale run.lock at ${opts.lockPath} held by run '${holder.runId}' ` +
        `(pid ${holder.pid} is no longer alive); acquiring fresh.`,
    );
  }

  // Reached only when both attempts lost the race: another acquirer recreated
  // the lock between our break and our retry. That is a genuine concurrent run.
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
 * Release a held lock by deleting its file. Idempotent: a missing file (already
 * released or broken by another acquirer) is ignored, so double-release and
 * release-after-break are both safe.
 */
export function releaseRunLock(handle: RunLockHandle): void {
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // Already gone; nothing to release.
  }
}

/**
 * Attempt to atomically create the lock file with `contents`.
 *
 * Writes a uniquely-named temp file, then `link(2)`s it onto `lockPath`. `link`
 * is the atomicity primitive: it fails with `EEXIST` if the target already
 * exists, which is how concurrent acquirers are serialised — exactly one link
 * succeeds. The temp is always unlinked in `finally` (the link created a second
 * name for the same inode; the temp name is no longer needed whether the link
 * won or lost).
 *
 * @returns `true` if the lock was created, `false` if it already existed.
 * @throws any non-`EEXIST` link error (an unexpected I/O fault).
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

/**
 * Remove an abandoned lock so it can be re-acquired. Best-effort: a concurrent
 * acquirer may have removed it first, so a missing-file error is ignored rather
 * than treated as a failure.
 */
function breakStaleLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Another acquirer may have removed it first; fine.
  }
}

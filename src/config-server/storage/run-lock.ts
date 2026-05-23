

import { linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createError } from '../errors.js';
import { readJsonObjectFile } from './json-read.js';

export interface RunLockContents {

  runId: string;

  pid: number;

  startedAt: string;

  hostname: string;
}

export type IsAlive = (pid: number) => boolean;

export const defaultIsAlive: IsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {

    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface RunLockHandle {

  lockPath: string;

  contents: RunLockContents;
}

export interface AcquireRunLockOptions {

  lockPath: string;

  runId: string;

  pid?: number;

  startedAt?: string;

  hostname?: string;

  isAlive?: IsAlive;

  warn?: (line: string) => void;
}

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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(opts.lockPath, contents)) {
      return { lockPath: opts.lockPath, contents };
    }

    const holder = readRunLock(opts.lockPath);
    if (holder === undefined) {

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

    breakStaleLock(opts.lockPath);
    warn(
      `Broke a stale run.lock at ${opts.lockPath} held by run '${holder.runId}' ` +
        `(pid ${holder.pid} is no longer alive); acquiring fresh.`,
    );
  }

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

export function releaseRunLock(handle: RunLockHandle): void {
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // Already gone; nothing to release.
  }
}

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

function breakStaleLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Another acquirer may have removed it first; fine.
  }
}

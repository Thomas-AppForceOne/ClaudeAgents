/**
 * Atomic file writes for the config server.
 *
 * R1 sprint 6 — every persistence path goes through `atomicWriteFile`. No
 * raw `fs.writeFileSync` outside this helper.
 *
 * Strategy: write the new contents to a sibling temp file in the same
 * directory as the target (`<path>.tmp.<pid>.<random>`), then `renameSync`
 * onto the target. On the same filesystem, `rename` is an atomic operation
 * — observers either see the old file or the fully-written new file, never
 * a half-written file. On rename failure the temp file is removed before
 * the error propagates so we never leak `*.tmp.*` siblings.
 *
 * Errors propagate via the central `createError` factory:
 *  - If the temp write itself fails, the helper attempts a best-effort
 *    cleanup and throws `MalformedInput` with the underlying message.
 *  - If the rename fails, same rule.
 *
 * The file content is written as UTF-8.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';

/**
 * Atomically replace `target` with `content`. Creates the parent directory
 * (recursive) if it does not already exist.
 *
 * @throws ConfigServerError(MalformedInput) on any I/O failure. The temp
 *   file (if it landed) is removed before the throw.
 */
export function atomicWriteFile(target: string, content: string): void {
  const dir = path.dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw createError('MalformedInput', {
      file: target,
      message: `The framework could not create the directory '${dir}' for atomic write: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }

  const tmp = tempPathFor(target);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8' });
  } catch (e) {
    // Best-effort cleanup in case a partial temp file landed.
    bestEffortUnlink(tmp);
    throw createError('MalformedInput', {
      file: target,
      message: `The framework could not write the temp file '${tmp}' for atomic write: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }

  try {
    renameSync(tmp, target);
  } catch (e) {
    bestEffortUnlink(tmp);
    throw createError('MalformedInput', {
      file: target,
      message: `The framework could not atomically rename '${tmp}' onto '${target}': ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }
}

/**
 * Build a unique temp-file path adjacent to `target`. Same directory →
 * same filesystem → `rename` is atomic. The suffix carries the process id
 * and a random hex string so concurrent writes within the same process
 * cannot collide.
 */
function tempPathFor(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return path.join(dir, `${base}.tmp.${process.pid}.${random}`);
}

function bestEffortUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // Ignore: nothing to clean, or platform refused. Rare and non-fatal.
  }
}

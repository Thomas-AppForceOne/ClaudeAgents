

/**
 * Crash-safe file writing for the config-server.
 *
 * Every durable write in the framework (overlays, stacks, run progress, the
 * trust cache, module state) funnels through {@link atomicWriteFile} so that a
 * crash, full disk, or signal mid-write can never leave a half-written file on
 * disk. The guarantee is delivered by the temp-file + rename dance: content is
 * written to a unique sibling temp file first, then `rename(2)` swaps it onto
 * the target. On POSIX a same-directory rename is atomic, so a reader sees
 * either the old file or the new one in full, never a partial blend.
 *
 * The temp file lives in the *same directory* as the target on purpose: rename
 * is only atomic within a single filesystem, and a temp under `/tmp` could land
 * on a different mount, silently degrading the swap into a copy.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';

/**
 * Write `content` to `target` atomically (temp-file write followed by rename).
 *
 * @param target absolute path of the file to (over)write; its parent directory
 *   is created recursively if missing.
 * @param content the full file contents to persist (UTF-8). The write is
 *   wholesale — any prior contents are replaced, never merged.
 *
 * Side effects: may create the parent directory; creates and then renames away
 * a temp sibling; on any failure the temp sibling is best-effort unlinked so a
 * failed write leaves no debris.
 *
 * Failure modes (all THROWN as `ConfigServerError` with code `MalformedInput`,
 * never returned): the parent directory cannot be created, the temp file cannot
 * be written, or the final rename fails. The underlying OS error message is
 * folded into the thrown error's message. There is no partial-write outcome —
 * either the rename lands and `target` holds the new content, or it throws and
 * `target` is untouched.
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
    // Drop the partially-written temp before surfacing the error, so a failed
    // write never strands a stale temp sibling next to the real file.
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
 * Build a unique temp path beside `target` for the pre-rename write.
 *
 * The name embeds the process pid and 6 random hex digits so that two
 * processes (or two concurrent writes within one process) racing on the same
 * target never collide on the temp file — only the final `rename` onto the
 * shared target serialises them. The temp sits in `target`'s own directory so
 * the subsequent rename stays within one filesystem (a cross-mount rename is
 * not atomic).
 */
function tempPathFor(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return path.join(dir, `${base}.tmp.${process.pid}.${random}`);
}

/**
 * Delete `p` if present, swallowing any error. Used only for temp-file cleanup
 * on the failure path, where the file may already be gone or the platform may
 * refuse the unlink — neither is worth masking the original write error that is
 * about to be thrown, so the failure is intentionally ignored.
 */
function bestEffortUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // Ignore: nothing to clean, or platform refused. Rare and non-fatal.
  }
}

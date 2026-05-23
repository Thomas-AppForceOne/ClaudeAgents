

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createError } from '../errors.js';

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

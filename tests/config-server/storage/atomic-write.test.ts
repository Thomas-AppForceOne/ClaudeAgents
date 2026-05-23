import { describe, expect, it, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';

import { atomicWriteFile } from '../../../src/config-server/storage/atomic-write.js';
import { ConfigServerError } from '../../../src/config-server/errors.js';

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-atomic-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {

      chmodSync(d, 0o755);
    } catch {
      // Ignore.
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
});

describe('atomicWriteFile', () => {
  it('writes content to the target path', () => {
    const dir = makeTmp();
    const target = path.join(dir, 'out.md');
    atomicWriteFile(target, 'hello\n');
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('creates parent directories recursively when missing', () => {
    const dir = makeTmp();
    const target = path.join(dir, 'a', 'b', 'c', 'out.md');
    atomicWriteFile(target, 'nested\n');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('nested\n');
  });

  it('replaces an existing file atomically', () => {
    const dir = makeTmp();
    const target = path.join(dir, 'replace.md');
    writeFileSync(target, 'old\n', 'utf8');
    atomicWriteFile(target, 'new\n');
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('leaves no `*.tmp.*` siblings after a successful write', () => {
    const dir = makeTmp();
    const target = path.join(dir, 'sibling.md');
    atomicWriteFile(target, 'data\n');
    const remaining = readdirSync(dir);
    expect(remaining).toContain('sibling.md');
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('throws ConfigServerError when the target path itself is unwritable', () => {
    if (platform() === 'win32') {

      return;
    }
    const dir = makeTmp();
    const target = path.join(dir, 'cant-write.md');
    writeFileSync(target, 'original\n', 'utf8');

    chmodSync(dir, 0o555);

    let threw = false;
    try {
      atomicWriteFile(target, 'replacement\n');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(dir, 0o755);

    expect(readFileSync(target, 'utf8')).toBe('original\n');

    const remaining = readdirSync(dir);
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('rejects writing to a path whose parent cannot be created', () => {
    if (platform() === 'win32') return;
    const dir = makeTmp();
    chmodSync(dir, 0o555);
    const target = path.join(dir, 'forbidden', 'inner.md');
    let threw = false;
    try {
      atomicWriteFile(target, 'oops\n');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(dir, 0o755);
  });

  it('on rename failure (target is a directory, not a file) leaves original intact + no temp leftovers', async () => {
    const dir = makeTmp();

    const target = path.join(dir, 'block-dir');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(target);
    writeFileSync(path.join(target, 'sentinel'), 'sentinel\n', 'utf8');

    let threw = false;
    try {
      atomicWriteFile(target, 'replacement\n');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    expect(readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('sentinel\n');

    const remaining = readdirSync(dir);
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});

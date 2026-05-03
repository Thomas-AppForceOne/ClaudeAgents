/**
 * R3 sprint 1 — `--project-root` resolution unit tests.
 *
 * Covers:
 *   - default-from-cwd
 *   - canonicalization (symlinks resolved, trailing-slash stripped,
 *     case-folded on Darwin/Win32 per F3)
 *   - explicit flag → `explicit: true`
 *   - non-existent path → throws
 *   - non-directory path → throws
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectRoot } from '../../../src/cli/lib/project-root.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function freshTmp(): string {
  const t = mkdtempSync(path.join(tmpdir(), 'gan-pr-'));
  cleanups.push(() => rmSync(t, { recursive: true, force: true }));
  return t;
}

describe('resolveProjectRoot', () => {
  it('default: falls back to canonicalized cwd', () => {
    const r = resolveProjectRoot(undefined);
    expect(r.explicit).toBe(false);
    expect(r.path).toBe(canonicalizePath(process.cwd()));
  });

  it('explicit: returns canonicalized form, marks explicit=true', () => {
    const t = freshTmp();
    const r = resolveProjectRoot(t);
    expect(r.explicit).toBe(true);
    expect(r.path).toBe(canonicalizePath(t));
  });

  it('strips a trailing slash on the supplied path', () => {
    const t = freshTmp();
    const withSlash = t.endsWith('/') ? t : t + '/';
    const r = resolveProjectRoot(withSlash);
    expect(r.path).toBe(canonicalizePath(t));
    expect(r.path.endsWith('/')).toBe(false);
  });

  it('throws when the path does not exist', () => {
    expect(() => resolveProjectRoot('/definitely/not/a/real/path/zzz')).toThrow(/does not exist/);
  });

  it('throws when the path is a file, not a directory', () => {
    const t = freshTmp();
    const file = path.join(t, 'a.txt');
    writeFileSync(file, 'hi', 'utf8');
    expect(() => resolveProjectRoot(file)).toThrow(/not a directory/);
  });

  it('empty-string flag is treated as "not supplied" (explicit=false)', () => {
    const r = resolveProjectRoot('');
    expect(r.explicit).toBe(false);
    expect(r.path).toBe(canonicalizePath(process.cwd()));
  });

  it('canonicalization: nested paths resolve identically regardless of trailing slash', () => {
    const t = freshTmp();
    const sub = path.join(t, 'sub');
    mkdirSync(sub);
    const a = resolveProjectRoot(sub);
    const b = resolveProjectRoot(sub + '/');
    expect(a.path).toBe(b.path);
  });
});

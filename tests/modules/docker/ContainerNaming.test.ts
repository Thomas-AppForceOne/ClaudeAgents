// Contract for ContainerNaming.nameForWorktree — the deterministic mapping from
// a worktree path to a Docker-safe container name. Docker container names are
// constrained to [a-z0-9._-] and must start with an alphanumeric, so the suite
// verifies the sanitisation pipeline (lowercase, replace illegal chars with -,
// collapse repeated -, trim a leading non-alphanumeric run) and the disambiguating
// 4-hex suffix. That suffix is the sha256 prefix of the CANONICAL path, which is
// what keeps two distinct worktrees whose last path segments sanitise to the same
// string from colliding on a single container name. Determinism is asserted first
// because the whole port/container registry relies on the same path producing the
// same name across processes.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nameForWorktree } from '../../../src/modules/docker/ContainerNaming.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

describe('ContainerNaming.nameForWorktree', () => {
  it('is deterministic for the same input', () => {
    const wt = '/tmp/proj-worktree-a1b2c3';
    expect(nameForWorktree(wt)).toBe(nameForWorktree(wt));
  });

  it('lowercases the last segment', () => {
    const wt = '/tmp/PROJ-WORKTREE-A1B2C3';
    const out = nameForWorktree(wt);

    // Strip the trailing "-XXXX" hash suffix (5 chars) to inspect just the
    // sanitised name core; the hash itself is lowercase hex so it is irrelevant here.
    const core = out.slice(0, out.length - 5);
    expect(core).toBe(core.toLowerCase());
    expect(core).toContain('proj-worktree-a1b2c3');
  });

  it('replaces special characters with -', () => {
    // A real on-disk directory is created so the canonicalisation step (which may
    // touch the filesystem) has a path to resolve; the segment name carries the
    // illegal characters under test.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-naming-'));
    try {
      const wt = path.join(scratch, 'weird@@name##with$$chars');
      mkdirSync(wt, { recursive: true });
      const out = nameForWorktree(wt);

      // Whole name conforms to the Docker charset and ends in the 4-hex suffix.
      expect(out).toMatch(/^[a-z0-9._-]+-[0-9a-f]{4}$/);

      expect(out).not.toContain('@');
      expect(out).not.toContain('#');
      expect(out).not.toContain('$');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('collapses runs of - into a single -', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-naming-'));
    try {
      const wt = path.join(scratch, 'foo---bar');
      mkdirSync(wt, { recursive: true });
      const out = nameForWorktree(wt);
      const core = out.slice(0, out.length - 5);
      expect(core).not.toContain('---');
      expect(core).not.toContain('--');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('trims leading non-[a-z0-9] characters', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-naming-'));
    try {
      const wt = path.join(scratch, '---leading-dashes');
      mkdirSync(wt, { recursive: true });
      const out = nameForWorktree(wt);

      expect(out[0]).toMatch(/[a-z0-9]/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('appends a 4-hex suffix that is the sha256 prefix of the canonical worktree path', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-naming-'));
    try {
      const wt = path.join(scratch, 'verify-hash');
      mkdirSync(wt, { recursive: true });
      const out = nameForWorktree(wt);
      // Recompute the suffix the implementation must produce: the first 4 hex
      // chars of sha256 over the CANONICAL path (not the raw input) — using the
      // canonical form is what makes the suffix stable and collision-resistant.
      const expectedHex = createHash('sha256')
        .update(canonicalizePath(wt))
        .digest('hex')
        .slice(0, 4);
      expect(out.endsWith(`-${expectedHex}`)).toBe(true);

      const tail = out.slice(out.length - 4);
      expect(tail).toMatch(/^[0-9a-f]{4}$/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});



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

    const core = out.slice(0, out.length - 5);
    expect(core).toBe(core.toLowerCase());
    expect(core).toContain('proj-worktree-a1b2c3');
  });

  it('replaces special characters with -', () => {

    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-naming-'));
    try {
      const wt = path.join(scratch, 'weird@@name##with$$chars');
      mkdirSync(wt, { recursive: true });
      const out = nameForWorktree(wt);

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

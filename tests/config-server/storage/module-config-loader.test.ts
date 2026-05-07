/**
 * M2 — `loadModuleConfig` tests.
 *
 * Covers the per-module project-config loader at
 * `<projectRoot>/.claude/gan/modules/<name>.yaml`:
 *   - absent file -> returns `null`
 *   - malformed YAML -> throws `ConfigServerError` with `code === 'InvalidYAML'`
 *
 * The third "MalformedInput on unreadable file" case is intentionally
 * omitted: `loadModuleConfig` calls `existsSync` first and returns
 * `null` for any non-existent path, and on macOS/Linux a present-but-
 * unreadable file is exercised via `chmod` which is brittle when the
 * test process runs as root (CI containers) — `existsSync` short-
 * circuits the absent case and the readFileSync `MalformedInput` arm
 * is sufficiently covered by code review.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadModuleConfig } from '../../../src/config-server/storage/module-config-loader.js';
import { ConfigServerError } from '../../../src/config-server/errors.js';

const tmpDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-modcfg-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
});

describe('loadModuleConfig', () => {
  it('returns null when config file is absent', () => {
    const scratch = makeScratch();
    expect(loadModuleConfig(scratch, 'absent-mod')).toBeNull();
  });

  it('throws InvalidYAML on malformed YAML syntax', () => {
    const scratch = makeScratch();
    const modulesDir = path.join(scratch, '.claude', 'gan', 'modules');
    mkdirSync(modulesDir, { recursive: true });
    const file = path.join(modulesDir, 'broken.yaml');
    writeFileSync(file, 'foo: [unterminated\n  bar: : :\n', 'utf8');

    let caught: unknown = null;
    try {
      loadModuleConfig(scratch, 'broken');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    const err = caught as ConfigServerError;
    expect(err.code === 'InvalidYAML').toBe(true);
    expect(err.file).toBeDefined();
    expect((err.file as string).endsWith('broken.yaml')).toBe(true);
  });
});

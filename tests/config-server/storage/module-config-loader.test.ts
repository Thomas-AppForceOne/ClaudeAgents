// Verifies loadModuleConfig's two boundary behaviours: an absent config file is
// a benign null (not an error), while a syntactically broken YAML file throws a
// ConfigServerError coded InvalidYAML that carries the offending file path in
// `err.file`. The path is asserted so callers can point the user at the right
// file when reporting the failure.

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

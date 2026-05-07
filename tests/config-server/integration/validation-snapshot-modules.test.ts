/**
 * M1 — Sprint M1 — ValidationSnapshot.modules / ResolvedConfig.modules
 * shape integration test (AC8 + AC15).
 *
 * Registers two fixture modules via an injected modulesRoot, calls both
 * `validateAll` and `getResolvedConfig`, asserts both surfaces include
 * a `modules` array whose rows expose exactly `name`, `manifestPath`,
 * and (when present) `pairsWith` — no extras, no rename.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { _runPhase1ForTests } from '../../../src/config-server/tools/validate.js';
import { composeResolvedConfig } from '../../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';

describe('ValidationSnapshot.modules / ResolvedConfig.modules shape', () => {
  let scratch: string;
  let modulesScratch: string;
  let projectScratch: string;

  beforeEach(() => {
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-snapshot-'));
    modulesScratch = path.join(scratch, 'modules-root');
    projectScratch = path.join(scratch, 'project-root');
    mkdirSync(modulesScratch, { recursive: true });
    mkdirSync(projectScratch, { recursive: true });

    // Stage two fixture modules under the modulesScratch.
    const stagedA = path.join(modulesScratch, 'mod-alpha');
    mkdirSync(stagedA, { recursive: true });
    writeFileSync(
      path.join(stagedA, 'manifest.json'),
      JSON.stringify({
        name: 'mod-alpha',
        schemaVersion: 1,
        description: 'Alpha fixture module.',
        exports: ['alphaSentinel'],
        pairsWith: 'alpha-stack',
      }),
    );

    const stagedB = path.join(modulesScratch, 'mod-beta');
    mkdirSync(stagedB, { recursive: true });
    // Beta carries no pairsWith so we exercise the omitted-field branch.
    writeFileSync(
      path.join(stagedB, 'manifest.json'),
      JSON.stringify({
        name: 'mod-beta',
        schemaVersion: 1,
        description: 'Beta fixture module without a paired stack.',
        exports: ['betaSentinel'],
      }),
    );
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
  });

  it('validateAll snapshot exposes modules with exactly {name, manifestPath, pairsWith?}', () => {
    // Use _runPhase1ForTests to inspect the snapshot directly.
    const snapshot = _runPhase1ForTests(projectScratch, { modulesRoot: modulesScratch });
    expect(snapshot.modules).toHaveLength(2);
    const names = snapshot.modules.map((m) => m.name).sort();
    expect(names).toEqual(['mod-alpha', 'mod-beta']);
    const alpha = snapshot.modules.find((m) => m.name === 'mod-alpha');
    const beta = snapshot.modules.find((m) => m.name === 'mod-beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // Alpha: keys must be exactly {name, manifestPath, pairsWith}.
    expect(Object.keys(alpha!).sort()).toEqual(['manifestPath', 'name', 'pairsWith']);
    expect(alpha!.pairsWith).toBe('alpha-stack');
    expect(typeof alpha!.manifestPath).toBe('string');
    // Beta: keys must be exactly {name, manifestPath} (pairsWith omitted).
    expect(Object.keys(beta!).sort()).toEqual(['manifestPath', 'name']);
    // No `manifest`, `description`, `exports`, etc. leak through.
    for (const m of snapshot.modules) {
      const allowed = new Set(['name', 'manifestPath', 'pairsWith']);
      for (const k of Object.keys(m)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
  });

  it('validateAll surfaces zero issues for the modules portion when manifests are valid', () => {
    const result = validateAll(
      { projectRoot: projectScratch },
      { modulesRoot: modulesScratch },
    );
    // No invariant fires (no stack files at all in projectScratch).
    expect(result.issues).toEqual([]);
  });

  it('getResolvedConfig.modules carries the same rows keyed by name', async () => {
    const r = await composeResolvedConfig(projectScratch, {
      apiVersion: '0.0.0-test',
      modulesRoot: modulesScratch,
    });
    // M2 keys modules by name (object) so per-module config is
    // accessible via `r.modules.<name>.<field>`. The module-registration
    // surface (name, manifestPath, pairsWith) lives on the same row.
    expect(Array.isArray(r.modules)).toBe(false);
    expect(typeof r.modules).toBe('object');
    const names = Object.keys(r.modules).sort();
    expect(names).toEqual(['mod-alpha', 'mod-beta']);
    for (const name of names) {
      const m = r.modules[name];
      const allowed = new Set(['name', 'manifestPath', 'pairsWith']);
      for (const k of Object.keys(m)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
    const alpha = r.modules['mod-alpha'];
    expect(alpha.pairsWith).toBe('alpha-stack');
    const beta = r.modules['mod-beta'];
    expect(beta.pairsWith).toBeUndefined();
  });

  it('reads a manifest.json from disk for each row', () => {
    const snapshot = _runPhase1ForTests(projectScratch, { modulesRoot: modulesScratch });
    for (const m of snapshot.modules) {
      const text = readFileSync(m.manifestPath, 'utf8');
      const parsed = JSON.parse(text);
      expect(parsed.name).toBe(m.name);
    }
  });
});

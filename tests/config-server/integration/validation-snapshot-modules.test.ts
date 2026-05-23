/**
 * Shape contract for the `modules` collection as it appears in two parallel
 * outputs: the validation snapshot (`ValidationSnapshot.modules`, an array) and
 * the resolved config (`ResolvedConfig.modules`, an object keyed by name). Both
 * must expose the *same* per-module rows carrying exactly the allowed fields —
 * `name`, `manifestPath`, and an optional `pairsWith` — and nothing more.
 *
 * The fixture stages two manifests in a scratch modules-root: `mod-alpha` (with
 * a `pairsWith`) and `mod-beta` (without), so the suite proves both the
 * present-and-absent `pairsWith` cases. The tightest assertions enumerate the
 * exact key set per row (`Object.keys(...).sort()`) and reject any key outside
 * the allowlist — this is the guard against the snapshot leaking extra manifest
 * fields (e.g. exports, description) into the public shape. A final test reads
 * each row's `manifestPath` back off disk to confirm it points at the real
 * manifest whose `name` matches the row.
 *
 * Uses the `_runPhase1ForTests` seam to inspect the snapshot directly without
 * running the whole validation pipeline.
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

    const snapshot = _runPhase1ForTests(projectScratch, { modulesRoot: modulesScratch });
    expect(snapshot.modules).toHaveLength(2);
    const names = snapshot.modules.map((m) => m.name).sort();
    expect(names).toEqual(['mod-alpha', 'mod-beta']);
    const alpha = snapshot.modules.find((m) => m.name === 'mod-alpha');
    const beta = snapshot.modules.find((m) => m.name === 'mod-beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Exact key set per row: alpha carries the optional pairsWith, beta omits
    // it entirely (not present-as-undefined). Enumerating keys this strictly is
    // what catches the snapshot leaking other manifest fields into the shape.
    expect(Object.keys(alpha!).sort()).toEqual(['manifestPath', 'name', 'pairsWith']);
    expect(alpha!.pairsWith).toBe('alpha-stack');
    expect(typeof alpha!.manifestPath).toBe('string');

    expect(Object.keys(beta!).sort()).toEqual(['manifestPath', 'name']);

    // Belt-and-braces allowlist sweep across every row, so an extra field on
    // any future module is rejected even if it is not alpha/beta.
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

    expect(result.issues).toEqual([]);
  });

  it('getResolvedConfig.modules carries the same rows keyed by name', async () => {
    const r = await composeResolvedConfig(projectScratch, {
      apiVersion: '0.0.0-test',
      modulesRoot: modulesScratch,
    });

    // Resolved config keys modules by name (an object), not as an array — the
    // counterpart shape to the snapshot's array, carrying the same rows.
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

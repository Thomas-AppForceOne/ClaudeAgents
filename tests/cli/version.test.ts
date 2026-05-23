/**
 * End-to-end tests for `gan version` (feature acceptance criterion F-AC1).
 *
 * Verifies the version surface in both human and `--json` modes: it reports
 * apiVersion / serverVersion / schemas, the JSON form is canonical (sorted
 * keys, two-space indent, trailing newline) and deterministic across runs, and
 * apiVersion and serverVersion agree because both are read from the single
 * `package.json` — guarding against the two drifting apart.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

describe('gan version', () => {
  it('F-AC1: `gan version` exits 0 with apiVersion / serverVersion / schemas on stdout', async () => {
    const r = await runGan(['version']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/apiVersion:/);
    expect(r.stdout).toMatch(/serverVersion:/);
    expect(r.stdout).toMatch(/schemas:/);
  });

  it('F-AC1: `gan version --json` emits sorted-key, two-space-indent, trailing-newline JSON', async () => {
    const r = await runGan(['version', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    expect(r.stdout.endsWith('\n')).toBe(true);

    // A two-space-indented top-level key is the cheap structural proof that the
    // emitter pretty-prints with two spaces rather than tabs or compact JSON.
    expect(r.stdout).toContain('\n  "');

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('serverVersion');
    expect(parsed).toHaveProperty('schemas');
    expect(Array.isArray(parsed.schemas)).toBe(true);

    // Key order is asserted exactly (alphabetical) — the determinism contract is
    // sorted keys, so `schemas` must sit between the two version fields.
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['apiVersion', 'schemas', 'serverVersion']);
  });

  it('F-AC1: schemas[] entries have name + version (number)', async () => {
    const r = await runGan(['version', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { schemas: Array<{ name: string; version: number }> };
    expect(parsed.schemas.length).toBeGreaterThanOrEqual(1);
    for (const s of parsed.schemas) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.version).toBe('number');
    }

    // The two schemas the framework actually versions must both be advertised.
    const names = parsed.schemas.map((s) => s.name);
    expect(names).toContain('stack');
    expect(names).toContain('overlay');
  });

  it('F-AC1: round-trip determinism — repeated invocations are byte-identical', async () => {
    const a = await runGan(['version', '--json']);
    const b = await runGan(['version', '--json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('F-AC1: apiVersion equals serverVersion (both read from package.json)', async () => {
    const r = await runGan(['version', '--json']);
    const parsed = JSON.parse(r.stdout) as { apiVersion: string; serverVersion: string };
    expect(parsed.apiVersion).toBe(parsed.serverVersion);
  });
});

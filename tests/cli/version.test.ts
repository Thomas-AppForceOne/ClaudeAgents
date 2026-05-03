/**
 * R3 sprint 1 — `gan version` + `--json` round-trip determinism.
 *
 * Covers contract criterion F-AC1.
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
    // Trailing newline (F3 determinism rule).
    expect(r.stdout.endsWith('\n')).toBe(true);
    // Two-space indent.
    expect(r.stdout).toContain('\n  "');
    // Parse cleanly.
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('serverVersion');
    expect(parsed).toHaveProperty('schemas');
    expect(Array.isArray(parsed.schemas)).toBe(true);
    // Sorted keys at the top level: apiVersion < schemas < serverVersion.
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
    // Includes the schemas R1 ships on disk.
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

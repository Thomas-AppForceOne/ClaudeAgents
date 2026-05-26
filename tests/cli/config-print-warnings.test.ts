/**
 * End-to-end tests for the W1 overlay-misuse warning surface on
 * `gan config print`.
 *
 * Covers the `--json` top-level `warnings` array (always present, in stable
 * sorted-key position via the deterministic JSON helper) and the human-format
 * warnings prose printed below the resolved-config table. Run against the
 * Sprint-1 overlay-warn-* fixtures so the surface is exercised against the real
 * data layer. The no-warning case is asserted to leave the human table verbatim
 * (no warnings section).
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import type { Warning } from '../../src/index.js';

describe('gan config print — W1 warnings', () => {
  it('--json carries a top-level warnings array with structured entries', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(r.stdout) as { warnings: Warning[] };
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings).toHaveLength(1);
    const w = parsed.warnings[0];
    expect(w.code).toBe('StackOverrideShrinkage');
    expect(typeof w.message).toBe('string');
    expect(w.details).toMatchObject({ code: 'StackOverrideShrinkage', suppressed: ['web-node'] });
  });

  it('--json keeps the existing resolved-config keys alongside warnings, with sorted keys', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // The pre-W1 keys are still present; warnings is an addition.
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('stacks');
    expect(parsed).toHaveProperty('issues');
    expect(parsed).toHaveProperty('warnings');
    // Top-level keys are emitted in sorted order (byte-determinism basis).
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it('--json is byte-stable across runs over the same snapshot', async () => {
    const fixture = stackFixturePath('overlay-warn-combined');
    const a = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    const b = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('human format prints warnings as prose below the resolved-config table', async () => {
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['config', 'print', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    // The warnings section follows the table, after the issues row.
    const issuesIdx = r.stdout.indexOf('issues:');
    const warningsIdx = r.stdout.indexOf('warnings:');
    expect(issuesIdx).toBeGreaterThanOrEqual(0);
    expect(warningsIdx).toBeGreaterThan(issuesIdx);

    // The prose reuses the startup-log `<code>: <message>` shape.
    expect(r.stdout).toMatch(/\nwarnings:\n/);
    expect(r.stdout).toContain('StackOverrideShrinkage: ');
    expect(r.stdout).toContain('stack.override');
  });

  it('human format prints one prose line per warning when several apply', async () => {
    const fixture = stackFixturePath('overlay-warn-combined');
    const r = await runGan(['config', 'print', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('StackOverrideShrinkage: ');
    expect(r.stdout).toContain('PerStackOverrideUnsupported: ');
  });

  it('human format omits the warnings section entirely when no warning applies', async () => {
    const fixture = stackFixturePath('overlay-warn-single-detection');
    const r = await runGan(['config', 'print', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    // The table verbatim: no warnings header, no warning codes.
    expect(r.stdout).not.toContain('warnings:');
    expect(r.stdout).not.toContain('StackOverrideShrinkage');
    expect(r.stdout).not.toContain('PerStackOverrideUnsupported');
  });
});

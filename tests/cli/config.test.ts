/**
 * R3 sprint 2 — `gan config print` and `gan config get`.
 *
 * Covers contract criteria F-AC3 (`config print --json | jq` round-trip)
 * plus the dotted-path semantics of `config get`, including the missing-
 * key exit-1 path.
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

const FIXTURE = stackFixturePath('js-ts-minimal');

describe('gan config print', () => {
  it('F-AC3: human surface lists active stacks, schema versions, issues', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/apiVersion:/);
    expect(r.stdout).toMatch(/schemaVersions:/);
    expect(r.stdout).toMatch(/active stacks:/);
    expect(r.stdout).toMatch(/issues:/);
  });

  it('F-AC3: --json emits sorted-key, two-space, trailing-newline JSON parsable as the resolved config', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout).toContain('\n  "');

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // F2 stable-shape: every read returns these top-level keys.
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('schemaVersions');
    expect(parsed).toHaveProperty('stacks');
    expect(parsed).toHaveProperty('overlay');
    expect(parsed).toHaveProperty('discarded');
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed).toHaveProperty('issues');

    // Sorted-keys property: top-level keys come out in lex order.
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('F-AC3: --json round-trips byte-identically across runs (determinism)', async () => {
    const a = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    const b = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('F-AC3: --json output parses cleanly via JSON.parse (jq-equivalent contract)', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    // Throws if the document isn't valid JSON.
    const parsed = JSON.parse(r.stdout) as { apiVersion: string };
    expect(typeof parsed.apiVersion).toBe('string');
  });
});

describe('gan config get', () => {
  it('returns the apiVersion at a known key', async () => {
    const r = await runGan(['config', 'get', 'apiVersion', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    // Human form prints strings unquoted.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns nested values via dotted paths', async () => {
    const r = await runGan(['config', 'get', 'schemaVersions.stack', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  it('--json emits the value as a JSON document (sorted, indented, trailing newline)', async () => {
    const r = await runGan([
      'config',
      'get',
      'schemaVersions',
      '--project-root',
      FIXTURE,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { stack: number; overlay: number };
    expect(parsed.stack).toBe(1);
    expect(parsed.overlay).toBe(1);
  });

  it('returns array values verbatim', async () => {
    const r = await runGan(['config', 'get', 'stacks.active', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as string[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('missing key exits 1 with stderr mentioning the path', async () => {
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/key not found/);
    expect(r.stderr).toContain('no.such.path');
  });

  it('missing key under --json emits a structured error to stdout, exit 1', async () => {
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout) as { code: string; message: string; field: string };
    expect(parsed.code).toBe('KeyNotFound');
    expect(parsed.field).toBe('no.such.path');
    expect(parsed.message).toMatch(/key not found/);
  });

  it('no path argument exits 64 with bad-args framing', async () => {
    const r = await runGan(['config', 'get', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/dotted path/);
  });
});

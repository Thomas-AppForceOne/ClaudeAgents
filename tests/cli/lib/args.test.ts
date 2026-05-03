/**
 * R3 sprint 1 — bespoke arg parser unit tests.
 *
 * Exercises every documented surface from `src/cli/lib/args.ts`:
 *   - `--flag=value` and `--flag value`
 *   - `--` terminator
 *   - repeated flags
 *   - missing-value rejection
 *   - unknown-flag detection (without throwing)
 *   - short-form `-h` aliasing
 */
import { describe, expect, it } from 'vitest';
import { GLOBAL_FLAGS, parseArgs, type CommandSpec } from '../../../src/cli/lib/args.js';

const SPEC: CommandSpec = {
  flags: [...GLOBAL_FLAGS, { long: '--tier', type: 'string' }],
};

describe('parseArgs', () => {
  it('parses --flag=value', () => {
    const r = parseArgs(['--project-root=/tmp/x'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['project-root']).toBe('/tmp/x');
  });

  it('parses --flag value', () => {
    const r = parseArgs(['--project-root', '/tmp/x'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['project-root']).toBe('/tmp/x');
  });

  it('parses -h as boolean help', () => {
    const r = parseArgs(['-h'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['help']).toBe(true);
  });

  it('parses --json as boolean', () => {
    const r = parseArgs(['--json'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['json']).toBe(true);
  });

  it('-- terminator forces remainder to positional', () => {
    const r = parseArgs(['--', '--json', '--project-root', 'xyz'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.doubleDashSeen).toBe(true);
    expect(r._).toEqual(['--json', '--project-root', 'xyz']);
    // Crucially, --json after -- is NOT honored as a flag.
    expect(r.flags['json']).toBe(false);
  });

  it('repeated string flags: last wins', () => {
    const r = parseArgs(['--project-root', '/a', '--project-root', '/b'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['project-root']).toBe('/b');
  });

  it('repeated boolean flags: stays true', () => {
    const r = parseArgs(['--json', '--json'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r.flags['json']).toBe(true);
  });

  it('missing-value: --project-root with nothing after it', () => {
    const r = parseArgs(['--project-root'], SPEC);
    expect(r.error).toBeDefined();
    expect(r.error?.kind).toBe('missing-value');
    expect(r.error?.flag).toBe('--project-root');
  });

  it('missing-value: --project-root followed by another flag', () => {
    const r = parseArgs(['--project-root', '--json'], SPEC);
    expect(r.error).toBeDefined();
    expect(r.error?.kind).toBe('missing-value');
  });

  it('unknown flag: returns structured error, does not throw', () => {
    const r = parseArgs(['--nope'], SPEC);
    expect(r.error).toBeDefined();
    expect(r.error?.kind).toBe('unknown-flag');
    expect(r.error?.flag).toBe('--nope');
    expect(r.error?.message).toContain('--help');
  });

  it('unknown =-form flag: returns structured error', () => {
    const r = parseArgs(['--nope=foo'], SPEC);
    expect(r.error).toBeDefined();
    expect(r.error?.kind).toBe('unknown-flag');
    expect(r.error?.flag).toBe('--nope');
  });

  it('boolean flag with =value: rejects unless true/false', () => {
    const ok1 = parseArgs(['--json=true'], SPEC);
    expect(ok1.error).toBeUndefined();
    expect(ok1.flags['json']).toBe(true);

    const ok2 = parseArgs(['--json=false'], SPEC);
    expect(ok2.error).toBeUndefined();
    expect(ok2.flags['json']).toBe(false);

    const bad = parseArgs(['--json=yes'], SPEC);
    expect(bad.error).toBeDefined();
    expect(bad.error?.kind).toBe('missing-value');
  });

  it('positional args preserved in order', () => {
    const r = parseArgs(['stacks', 'new', 'ios'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r._).toEqual(['stacks', 'new', 'ios']);
  });

  it('mixed positional + flags', () => {
    const r = parseArgs(['stacks', 'new', 'ios', '--tier=project'], SPEC);
    expect(r.error).toBeUndefined();
    expect(r._).toEqual(['stacks', 'new', 'ios']);
    expect(r.flags['tier']).toBe('project');
  });

  it('empty argv: no error, no positional', () => {
    const r = parseArgs([], SPEC);
    expect(r.error).toBeUndefined();
    expect(r._).toEqual([]);
  });

  it('default boolean flag value is false', () => {
    const r = parseArgs([], SPEC);
    expect(r.flags['json']).toBe(false);
    expect(r.flags['help']).toBe(false);
  });

  it('allowUnknownFlags=true treats unknown flags as positional', () => {
    const lenient: CommandSpec = { flags: [...GLOBAL_FLAGS], allowUnknownFlags: true };
    const r = parseArgs(['--nope'], lenient);
    expect(r.error).toBeUndefined();
    expect(r._).toContain('--nope');
  });
});

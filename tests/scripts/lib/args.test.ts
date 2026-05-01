/**
 * Unit tests for `scripts/lib/args.ts`.
 *
 * Exercises the documented surface:
 *   - recognised boolean flags (`--json`, `--quiet`, `--help`)
 *   - recognised string flag (`--project-root <value>`, `--project-root=value`)
 *   - unknown flags collected in `unknown` (no throw)
 *   - positionals (non-flag tokens)
 *   - canonical `projectRoot` derivation (default `process.cwd()`,
 *     overridable via `--project-root`)
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/lib/index.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const SPEC = {
  boolean: ['json', 'quiet', 'help'] as const,
  string: ['project-root'] as const,
};

describe('parseArgs (scripts)', () => {
  it('seeds boolean flag defaults to false', () => {
    const r = parseArgs([], SPEC);
    expect(r.flags['json']).toBe(false);
    expect(r.flags['quiet']).toBe(false);
    expect(r.flags['help']).toBe(false);
    expect(r.unknown).toEqual([]);
    expect(r.positionals).toEqual([]);
  });

  it('recognises --json as a boolean flag', () => {
    const r = parseArgs(['--json'], SPEC);
    expect(r.flags['json']).toBe(true);
    expect(r.unknown).toEqual([]);
  });

  it('recognises --quiet and --help', () => {
    const r = parseArgs(['--quiet', '--help'], SPEC);
    expect(r.flags['quiet']).toBe(true);
    expect(r.flags['help']).toBe(true);
  });

  it('recognises --project-root <value> (two-token form)', () => {
    const r = parseArgs(['--project-root', '/tmp/x'], SPEC);
    expect(r.flags['project-root']).toBe('/tmp/x');
  });

  it('recognises --project-root=<value> (equals form)', () => {
    const r = parseArgs(['--project-root=/tmp/y'], SPEC);
    expect(r.flags['project-root']).toBe('/tmp/y');
  });

  it('unknown flags land in `unknown`, not in `flags`', () => {
    const r = parseArgs(['--bogus-flag'], SPEC);
    expect(r.unknown).toEqual(['--bogus-flag']);
    expect(r.flags['bogus-flag']).toBeUndefined();
    expect(r.positionals).toEqual([]);
  });

  it('unknown --flag=value is collected in `unknown`', () => {
    const r = parseArgs(['--also-bogus=1'], SPEC);
    expect(r.unknown).toEqual(['--also-bogus=1']);
  });

  it('positionals are collected separately from flags', () => {
    const r = parseArgs(['stack-name', 'extra'], SPEC);
    expect(r.positionals).toEqual(['stack-name', 'extra']);
    expect(r.unknown).toEqual([]);
  });

  it('mixed: flag, positional, unknown all separated correctly', () => {
    const r = parseArgs(['--json', 'name', '--bogus', 'tail'], SPEC);
    expect(r.flags['json']).toBe(true);
    expect(r.positionals).toEqual(['name', 'tail']);
    expect(r.unknown).toEqual(['--bogus']);
  });

  it('--project-root with no following value: collected as unknown (missing value)', () => {
    const r = parseArgs(['--project-root'], SPEC);
    // No value follows → flagged as unknown so the caller can map to
    // BAD_ARGS instead of inventing a value.
    expect(r.unknown).toEqual(['--project-root']);
  });

  it('default `projectRoot` is the canonicalised cwd', () => {
    const r = parseArgs([], SPEC);
    expect(r.projectRoot).toBe(canonicalizePath(process.cwd()));
  });

  it('explicit --project-root canonicalises the supplied path', () => {
    // Use a directory that definitely exists so canonicalizePath
    // resolves through realpathSync.native.
    const target = path.resolve(process.cwd());
    const r = parseArgs(['--project-root', target], SPEC);
    expect(r.projectRoot).toBe(canonicalizePath(target));
  });
});

/**
 * Unit tests for `parseArgs`, the shared argv parser every CLI bin in this
 * repo uses. The parser splits argv into three buckets — recognised flags,
 * positionals, and an `unknown` list — and derives a canonicalised
 * `projectRoot` from either `--project-root` or the cwd.
 *
 * These tests pin the parser's contract: boolean flags default to false,
 * string flags accept both the two-token and `--flag=value` forms, anything
 * not in the spec (including a string flag missing its value) lands in
 * `unknown` rather than throwing or being treated as a flag, and positionals
 * stay separate. The bins rely on this so an unknown flag can be turned into a
 * usage error (exit 64) rather than silently ignored.
 *
 * Regression guarded: a parser change that misclassified an unknown flag as
 * recognised, or that stopped canonicalising the project root, would break
 * every bin's flag handling at once.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/lib/index.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

// A representative spec: three boolean flags and one string flag, mirroring the
// shape the real bins declare.
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
    // A declared string flag with nothing after it is malformed input, so it
    // is bucketed as unknown rather than consuming the (absent) next token.
    const r = parseArgs(['--project-root'], SPEC);

    expect(r.unknown).toEqual(['--project-root']);
  });

  it('default `projectRoot` is the canonicalised cwd', () => {
    const r = parseArgs([], SPEC);
    expect(r.projectRoot).toBe(canonicalizePath(process.cwd()));
  });

  it('explicit --project-root canonicalises the supplied path', () => {
    // Use the already-resolved cwd as the input so the only transformation
    // under test is canonicalisation, not also relative-path resolution.
    const target = path.resolve(process.cwd());
    const r = parseArgs(['--project-root', target], SPEC);
    expect(r.projectRoot).toBe(canonicalizePath(target));
  });
});

/**
 * Black-box tests for the `publish-schemas` bin, which keeps the published
 * JSON schemas byte-canonical. In --dry-run it checks each schema matches its
 * canonical serialisation; in write mode it rewrites any drifted file back to
 * canonical form.
 *
 * The suite drives the compiled bin against a hermetic temp copy of the three
 * schemas so destructive cases (reformat, delete, break JSON) never touch the
 * checked-in originals. It covers the full failure taxonomy: clean dry-run,
 * drifted schema (SchemaDrift), write-mode repair restoring exact canonical
 * bytes, a deleted schema (SchemaMissing), invalid JSON (SchemaParseError),
 * the --json shape, and unknown-flag (exit 64) / --help paths.
 *
 * Regression guarded: the bin must keep detecting any deviation from the
 * canonical bytes — drift introduced by reformatting (here, re-indenting valid
 * JSON to 4 spaces) is a real failure, and write mode must reproduce the
 * canonical file exactly.
 *
 * NOTE: the writeFileSync payloads below (re-indented JSON, the broken
 * '{not valid' fragment) are deliberate corruption fixtures the bin reads; do
 * not edit inside those string literals.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript, repoRootDir } from '../helpers/spawn.js';

// The three schemas the bin governs; the clean run expects exactly these.
const SCHEMA_FILES = ['api-tools-v1.json', 'overlay-v1.json', 'stack-v1.json'] as const;

const CANONICAL_SCHEMA_ROOT = path.join(repoRootDir(), 'schemas');

// Copy the canonical schemas into a throwaway temp root so corruption tests
// operate on a private copy.
function makeHermeticSchemaRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'publish-schemas-'));
  mkdirSync(tmp, { recursive: true });
  for (const name of SCHEMA_FILES) {
    copyFileSync(path.join(CANONICAL_SCHEMA_ROOT, name), path.join(tmp, name));
  }
  return tmp;
}

// Temp roots created during the run, swept in afterAll.
const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const root = makeHermeticSchemaRoot();
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; OS will reap tmpdirs eventually.
    }
  }
});

describe('publish-schemas bin', () => {
  it('(T1a) default --dry-run → exit 0; stdout exactly `3 schemas checked, 0 failed\\n`; stderr empty', async () => {
    const r = await runScript('publish-schemas', ['--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('3 schemas checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('(T1b) --dry-run with corrupted schema → exit 1; stderr names SchemaDrift and the file path', async () => {
    const root = newTmpRoot();
    const corrupted = path.join(root, 'stack-v1.json');

    // Same semantic JSON, re-serialised with a 4-space indent: byte-different
    // from the canonical (2-space) form, so it must register as drift even
    // though the data is unchanged.
    const parsed: unknown = JSON.parse(readFileSync(corrupted, 'utf8'));

    writeFileSync(corrupted, JSON.stringify(parsed, null, 4) + '\n', 'utf8');

    const r = await runScript('publish-schemas', ['--dry-run', '--schema-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SchemaDrift');
    expect(r.stderr).toContain(corrupted);
  });

  it('(T1c) write mode repairs corrupted schema; follow-up --dry-run exits 0', async () => {
    const root = newTmpRoot();
    const corrupted = path.join(root, 'overlay-v1.json');
    // Re-indent to drift the file (as in T1b), then capture the canonical bytes
    // to assert write mode reproduces them exactly.
    const parsed: unknown = JSON.parse(readFileSync(corrupted, 'utf8'));
    writeFileSync(corrupted, JSON.stringify(parsed, null, 4) + '\n', 'utf8');

    const canonicalBytes = readFileSync(
      path.join(CANONICAL_SCHEMA_ROOT, 'overlay-v1.json'),
      'utf8',
    );

    const repair = await runScript('publish-schemas', ['--schema-root', root]);
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toBe('3 schemas checked, 0 failed\n');

    // Byte-for-byte equality with the canonical source proves the rewrite.
    const after = readFileSync(corrupted, 'utf8');
    expect(after).toBe(canonicalBytes);

    const followup = await runScript('publish-schemas', ['--dry-run', '--schema-root', root]);
    expect(followup.exitCode).toBe(0);
    expect(followup.stdout).toBe('3 schemas checked, 0 failed\n');
    expect(followup.stderr).toBe('');
  });

  it('(T1d) --dry-run with one schema deleted → exit 1; stderr names SchemaMissing and the file path', async () => {
    const root = newTmpRoot();
    const missing = path.join(root, 'api-tools-v1.json');
    rmSync(missing);

    const r = await runScript('publish-schemas', ['--dry-run', '--schema-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SchemaMissing');
    expect(r.stderr).toContain(missing);
    expect(r.stderr).toContain('schema file not found at');
  });

  it('(T1e) --dry-run with invalid JSON → exit 1; stderr names SchemaParseError and the file path', async () => {
    const root = newTmpRoot();
    const broken = path.join(root, 'stack-v1.json');
    writeFileSync(broken, '{not valid', 'utf8');

    const r = await runScript('publish-schemas', ['--dry-run', '--schema-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SchemaParseError');
    expect(r.stderr).toContain(broken);
  });

  it('(T1f) --json --dry-run clean run → exit 0; stdout parses to {checked:3, failed:0, failures:[]}', async () => {
    const r = await runScript('publish-schemas', ['--json', '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: unknown[];
    };
    expect(parsed.checked).toBe(3);
    expect(parsed.failed).toBe(0);
    expect(parsed.failures).toEqual([]);
  });

  it('(T1g) unknown flag → exit 64; stderr names the offending token and --help', async () => {
    const r = await runScript('publish-schemas', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('publish-schemas', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--schema-root');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--quiet');
    expect(r.stdout).toContain('api-tools-v1.json');
    expect(r.stdout).toContain('overlay-v1.json');
    expect(r.stdout).toContain('stack-v1.json');
  });
});

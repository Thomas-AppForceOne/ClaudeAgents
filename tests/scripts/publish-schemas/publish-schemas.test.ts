/**
 * Integration tests for `scripts/publish-schemas/`.
 *
 * Spawns the built bin (`dist/scripts/publish-schemas/index.js`) and
 * asserts:
 *
 *   (T1a) default `--dry-run` (no `--schema-root`) → exit 0; stdout is
 *         exactly `3 schemas checked, 0 failed\n`; stderr empty;
 *   (T1b) `--dry-run --schema-root <tmpdir>` with one schema corrupted
 *         (re-emitted via `JSON.stringify` with 4-space indent) → exit 1;
 *         stderr names `SchemaDrift` and the corrupted file's absolute
 *         path;
 *   (T1c) write mode against the same temp corrupted root → exit 0;
 *         after the run the file equals canonical bytes; follow-up
 *         `--dry-run` exits 0 with `3 schemas checked, 0 failed\n`;
 *   (T1d) `--dry-run --schema-root <tmpdir>` with one schema deleted →
 *         exit 1; stderr names `SchemaMissing` and the missing file's
 *         absolute path;
 *   (T1e) `--dry-run --schema-root <tmpdir>` with one schema's bytes
 *         invalid JSON → exit 1; stderr names `SchemaParseError` and
 *         that file's absolute path;
 *   (T1f) `--json --dry-run` against the canonical default root →
 *         exit 0; stdout JSON parses to `{checked:3, failed:0,
 *         failures:[]}` with trailing newline;
 *   (T1g) unknown flag → exit 64.
 *
 * Hermetic: cases (T1b)–(T1e) copy the canonical schemas from
 * `<repo>/schemas/` into a fresh `os.tmpdir()` directory via
 * `mkdtempSync` before mutating. The canonical schemas are never
 * mutated by these tests.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript, repoRootDir } from '../helpers/spawn.js';

const SCHEMA_FILES = ['api-tools-v1.json', 'overlay-v1.json', 'stack-v1.json'] as const;

const CANONICAL_SCHEMA_ROOT = path.join(repoRootDir(), 'schemas');

/**
 * Copy the three published schemas into a fresh tempdir and return its
 * absolute path. Caller is responsible for cleaning up via `rmSync`.
 */
function makeHermeticSchemaRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'publish-schemas-'));
  mkdirSync(tmp, { recursive: true });
  for (const name of SCHEMA_FILES) {
    copyFileSync(path.join(CANONICAL_SCHEMA_ROOT, name), path.join(tmp, name));
  }
  return tmp;
}

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
    // Re-emit the JSON with 4-space indent: parsed content unchanged but
    // bytes diverge from the canonical 2-space stableStringify form.
    const parsed: unknown = JSON.parse(readFileSync(corrupted, 'utf8'));
    // Note: tests can use JSON.stringify (only the script and report.ts
    // arms are constrained by AN2). This is the standard way to seed
    // drift in a hermetic root.
    writeFileSync(corrupted, JSON.stringify(parsed, null, 4) + '\n', 'utf8');

    const r = await runScript('publish-schemas', ['--dry-run', '--schema-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SchemaDrift');
    expect(r.stderr).toContain(corrupted);
  });

  it('(T1c) write mode repairs corrupted schema; follow-up --dry-run exits 0', async () => {
    const root = newTmpRoot();
    const corrupted = path.join(root, 'overlay-v1.json');
    const parsed: unknown = JSON.parse(readFileSync(corrupted, 'utf8'));
    writeFileSync(corrupted, JSON.stringify(parsed, null, 4) + '\n', 'utf8');

    // Capture the canonical bytes from the repo for the equality check.
    const canonicalBytes = readFileSync(
      path.join(CANONICAL_SCHEMA_ROOT, 'overlay-v1.json'),
      'utf8',
    );

    const repair = await runScript('publish-schemas', ['--schema-root', root]);
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toBe('3 schemas checked, 0 failed\n');

    // After the rewrite, the file bytes match the canonical form.
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

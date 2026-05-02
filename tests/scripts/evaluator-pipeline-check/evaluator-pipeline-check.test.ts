/**
 * Integration tests for `scripts/evaluator-pipeline-check/`.
 *
 * Spawns the built bin (`dist/scripts/evaluator-pipeline-check/index.js`)
 * and asserts:
 *
 *   (a) clean run (no flags) → exit 0, summary
 *       `3 fixtures checked, 0 failed`, stderr empty;
 *   (b) missing-golden temp root → exit 1; stderr names `GoldenMissing`
 *       and the offending fixture;
 *   (c) corrupted-golden temp root → exit 1; stderr names
 *       `GoldenDriftDetected`;
 *   (d) `--update-goldens` repairs a corrupted temp root, and a
 *       follow-up default run on the same temp root exits 0;
 *   (e) `--json` clean run → exit 0; stdout parses as
 *       `{checked:3, failed:0, failures:[]}` with a trailing newline;
 *   (f) unknown flag → exit 64; stdout empty; stderr names the offending
 *       token and `--help`.
 *
 * Hermetic: cases (b)/(c)/(d) copy the three bootstrap fixtures (with
 * their committed goldens) into a fresh `os.tmpdir()` directory via
 * `mkdtempSync`, then pass `--fixture-root <tmpdir>` to the script. The
 * canonical `tests/fixtures/stacks/<fixture>/golden.json` files are
 * never mutated.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runScript, repoRootDir } from '../helpers/spawn.js';

const BOOTSTRAP_FIXTURES = [
  'js-ts-minimal',
  'polyglot-webnode-synthetic',
  'synthetic-second',
] as const;

const CANONICAL_FIXTURE_ROOT = path.join(repoRootDir(), 'tests', 'fixtures', 'stacks');

/**
 * Copy the three bootstrap fixtures (including their committed
 * `golden.json` files) into a fresh tempdir and return its absolute
 * path. Caller is responsible for cleaning up via `rmSync`.
 */
function makeHermeticFixtureRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'eval-pipe-check-'));
  for (const fixture of BOOTSTRAP_FIXTURES) {
    cpSync(path.join(CANONICAL_FIXTURE_ROOT, fixture), path.join(tmp, fixture), {
      recursive: true,
    });
  }
  return tmp;
}

const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const root = makeHermeticFixtureRoot();
  tmpRoots.push(root);
  return root;
}

beforeAll(() => {
  // Pre-flight: confirm every canonical fixture (and its golden) exists,
  // so we fail fast with a clear message rather than exit-1 on every
  // assertion if a future refactor moves them.
  for (const fixture of BOOTSTRAP_FIXTURES) {
    const goldenPath = path.join(CANONICAL_FIXTURE_ROOT, fixture, 'golden.json');
    // Reading is the simplest existence + readability check.
    readFileSync(goldenPath, 'utf8');
  }
});

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS will reap tmpdirs eventually.
    }
  }
});

describe('evaluator-pipeline-check bin', () => {
  it('(a) clean run → exit 0; stdout exactly `3 fixtures checked, 0 failed\\n`; stderr empty', async () => {
    const r = await runScript('evaluator-pipeline-check');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('3 fixtures checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('(b) missing golden in temp root → exit 1; stderr names GoldenMissing and the fixture', async () => {
    const root = newTmpRoot();
    // Remove the golden for one fixture, leave the other two intact.
    rmSync(path.join(root, 'js-ts-minimal', 'golden.json'));

    const r = await runScript('evaluator-pipeline-check', ['--fixture-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('GoldenMissing');
    expect(r.stderr).toContain('js-ts-minimal');
  });

  it('(c) corrupted golden in temp root → exit 1; stderr names GoldenDriftDetected', async () => {
    const root = newTmpRoot();
    // Overwrite a golden with garbage.
    writeFileSync(
      path.join(root, 'synthetic-second', 'golden.json'),
      '{"issues":[{"code":"FabricatedGoldenDrift"}]}\n',
      'utf8',
    );

    const r = await runScript('evaluator-pipeline-check', ['--fixture-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('GoldenDriftDetected');
  });

  it('(d) --update-goldens repairs corrupted goldens; subsequent default run exits 0', async () => {
    const root = newTmpRoot();
    // Corrupt one golden.
    writeFileSync(
      path.join(root, 'polyglot-webnode-synthetic', 'golden.json'),
      '{"issues":[{"code":"FabricatedGoldenDrift"}]}\n',
      'utf8',
    );

    const repair = await runScript('evaluator-pipeline-check', [
      '--fixture-root',
      root,
      '--update-goldens',
    ]);
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toBe('3 fixtures checked, 0 failed\n');

    const followup = await runScript('evaluator-pipeline-check', ['--fixture-root', root]);
    expect(followup.exitCode).toBe(0);
    expect(followup.stdout).toBe('3 fixtures checked, 0 failed\n');
    expect(followup.stderr).toBe('');
  });

  it('(e) --json clean run → exit 0; stdout JSON {checked:3, failed:0, failures:[]} with trailing newline', async () => {
    const r = await runScript('evaluator-pipeline-check', ['--json']);
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

  it('(f) unknown flag → exit 64; stdout empty; stderr names the offending token and --help', async () => {
    const r = await runScript('evaluator-pipeline-check', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('evaluator-pipeline-check', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--fixture-root');
    expect(r.stdout).toContain('--update-goldens');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--quiet');
    expect(r.stdout).toContain('js-ts-minimal');
    expect(r.stdout).toContain('synthetic-second');
    expect(r.stdout).toContain('polyglot-webnode-synthetic');
  });
});

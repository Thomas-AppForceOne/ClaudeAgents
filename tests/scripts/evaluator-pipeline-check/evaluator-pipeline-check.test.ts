
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runScript, repoRootDir } from '../helpers/spawn.js';

const HARNESS_ENV: Record<string, string> = { GAN_PACKAGE_ROOT_OVERRIDE: '' };

const BOOTSTRAP_FIXTURES = [
  'generic-fallback',
  'js-ts-minimal',
  'node-packaged-non-web',
  'polyglot-webnode-synthetic',
  'synthetic-second',
] as const;

const CANONICAL_FIXTURE_ROOT = path.join(repoRootDir(), 'tests', 'fixtures', 'stacks');

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

  for (const fixture of BOOTSTRAP_FIXTURES) {
    const goldenPath = path.join(CANONICAL_FIXTURE_ROOT, fixture, 'expected-evaluator-plan.json');

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
  it('(a) clean run → exit 0; stdout exactly `5 fixtures checked, 0 failed\\n`; stderr empty', async () => {
    const r = await runScript('evaluator-pipeline-check', [], { extraEnv: HARNESS_ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('5 fixtures checked, 0 failed\n');
    expect(r.stderr).toBe('');
  });

  it('(b) missing golden in temp root → exit 1; stderr names EvaluatorPlanMissing and the fixture', async () => {
    const root = newTmpRoot();

    rmSync(path.join(root, 'js-ts-minimal', 'expected-evaluator-plan.json'));

    const r = await runScript('evaluator-pipeline-check', ['--fixture-root', root], {
      extraEnv: HARNESS_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EvaluatorPlanMissing');
    expect(r.stderr).toContain('js-ts-minimal');
  });

  it('(c) corrupted golden in temp root → exit 1; stderr names EvaluatorPlanDrift', async () => {
    const root = newTmpRoot();

    writeFileSync(
      path.join(root, 'synthetic-second', 'expected-evaluator-plan.json'),
      '{"issues":[{"code":"FabricatedDrift"}]}\n',
      'utf8',
    );

    const r = await runScript('evaluator-pipeline-check', ['--fixture-root', root], {
      extraEnv: HARNESS_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EvaluatorPlanDrift');
  });

  it('(d) --update-goldens repairs corrupted goldens; subsequent default run exits 0', async () => {
    const root = newTmpRoot();

    writeFileSync(
      path.join(root, 'polyglot-webnode-synthetic', 'expected-evaluator-plan.json'),
      '{"issues":[{"code":"FabricatedDrift"}]}\n',
      'utf8',
    );

    const repair = await runScript(
      'evaluator-pipeline-check',
      ['--fixture-root', root, '--update-goldens'],
      { extraEnv: HARNESS_ENV },
    );
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toBe('5 fixtures checked, 0 failed\n');

    const followup = await runScript('evaluator-pipeline-check', ['--fixture-root', root], {
      extraEnv: HARNESS_ENV,
    });
    expect(followup.exitCode).toBe(0);
    expect(followup.stdout).toBe('5 fixtures checked, 0 failed\n');
    expect(followup.stderr).toBe('');
  });

  it('(e) --json clean run → exit 0; stdout JSON {checked:5, failed:0, failures:[]} with trailing newline', async () => {
    const r = await runScript('evaluator-pipeline-check', ['--json'], { extraEnv: HARNESS_ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: unknown[];
    };
    expect(parsed.checked).toBe(5);
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
    expect(r.stdout).toContain('--allow-guardrail-removal');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--quiet');
    for (const fixture of BOOTSTRAP_FIXTURES) {
      expect(r.stdout).toContain(fixture);
    }
  });

  it('removing a known fixture without --allow-guardrail-removal exits 1', async () => {
    const root = newTmpRoot();
    rmSync(path.join(root, 'synthetic-second'), { recursive: true, force: true });

    const r = await runScript('evaluator-pipeline-check', ['--fixture-root', root], {
      extraEnv: HARNESS_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('GuardrailFixtureRemoved');
    expect(r.stderr).toContain('synthetic-second');
  });

  it('removing a known fixture under CI=1 with --allow-guardrail-removal still exits non-zero', async () => {
    const root = newTmpRoot();
    rmSync(path.join(root, 'synthetic-second'), { recursive: true, force: true });

    const r = await runScript(
      'evaluator-pipeline-check',
      ['--fixture-root', root, '--allow-guardrail-removal'],
      { extraEnv: { ...HARNESS_ENV, CI: '1' } },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('GuardrailRemovalRefusedUnderCI');
  });

  it('CI=1 with --allow-guardrail-removal and ALL fixtures present still exits non-zero', async () => {

    const root = newTmpRoot();

    const r = await runScript(
      'evaluator-pipeline-check',
      ['--fixture-root', root, '--allow-guardrail-removal'],
      { extraEnv: { ...HARNESS_ENV, CI: '1' } },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('GuardrailRemovalRefusedUnderCI');
  });
});

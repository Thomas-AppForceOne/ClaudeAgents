
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, type TmpHome } from './helpers/tmpenv.js';
import { renderedTemplate } from './helpers/confineTemplate.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

interface FixtureCase {
  name: string;
  spec?: boolean;
  path: string;
  expect: 'allow' | 'deny';
  why: string;

  runId?: string;
  unsetRunId?: boolean;

  worktree?: string;
  assertNoCanary?: boolean;
}

interface Fixture {
  runId: string;
  cases: FixtureCase[];
  security: FixtureCase[];
}

function loadFixture(): Fixture {
  const raw = readFileSync(
    path.join(repoRootDir(), 'tests', 'fixtures', 'hooks', 'confine-paths.json'),
    'utf8',
  );
  return JSON.parse(raw) as Fixture;
}

interface Sandbox {
  hookPath: string;
  home: string;

  worktree: string;

  rundir: string;
  canary: string;
}

function makeSandbox(): Sandbox {
  const tmp = makeTmpHome({ withRepo: false });
  cleanups.push(tmp);

  const worktree = path.join(tmp.root, 'user-worktree');
  const rundir = path.join(tmp.root, 'store', 'repo-key', 'runs', '20240115T091500-a1b2');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(rundir, { recursive: true });
  const hookPath = path.join(tmp.root, 'gan-confine.sh');
  writeFileSync(hookPath, renderedTemplate());
  chmodSync(hookPath, 0o755);
  return { hookPath, home: tmp.home, worktree, rundir, canary: path.join(tmp.root, 'CANARY') };
}

function expand(value: string, sb: Sandbox): string {
  return value
    .split('{worktree}')
    .join(sb.worktree)
    .split('{rundir}')
    .join(sb.rundir)
    .split('{home}')
    .join(sb.home)
    .split('{canary}')
    .join(sb.canary);
}

interface HookResult {
  exitCode: number;
  stderr: string;
}

function runHook(
  sb: Sandbox,
  candidate: string,
  runId: string | undefined,
  worktree: string,
): HookResult {
  const stdin = JSON.stringify({ tool_input: { file_path: candidate } });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: sb.home,

    CLAUDE_PROJECT_DIR: path.join(sb.home, 'project'),
    GAN_WORKTREE: worktree,
    GAN_RUN_DIR: sb.rundir,
  };
  if (runId !== undefined) {
    env.GAN_RUN_ID = runId;
  }
  const res = spawnSync('/bin/bash', [sb.hookPath], {
    input: stdin,
    env,
    encoding: 'utf8',
  });
  return { exitCode: res.status ?? 1, stderr: res.stderr ?? '' };
}

const fixture = loadFixture();

describe('F7 confine hook behavioral path matrix (data-driven from confine-paths.json)', () => {
  it('the fixture is valid JSON, covers the spec cases, and is read (not re-derived)', () => {
    expect(Array.isArray(fixture.cases)).toBe(true);
    expect(fixture.cases.length).toBeGreaterThan(0);

    const spec = fixture.cases.filter((c) => c.spec);
    const byVerdict = (v: 'allow' | 'deny') => spec.filter((c) => c.expect === v).map((c) => c.name);

    expect(byVerdict('allow').length).toBeGreaterThanOrEqual(2);

    expect(byVerdict('deny').length).toBeGreaterThanOrEqual(2);

    for (const c of [...fixture.cases, ...fixture.security]) {
      expect(typeof c.path).toBe('string');
      expect(c.expect === 'allow' || c.expect === 'deny').toBe(true);
    }
  });

  it('renders the same artifact install.sh ships (version-substituted template)', () => {
    const sb = makeSandbox();
    const onDisk = readFileSync(sb.hookPath, 'utf8');
    expect(onDisk).toBe(renderedTemplate());
    expect(onDisk).toContain(`version ${packageVersion()}.`);
  });

  it('STATIC: zones are sourced from GAN_WORKTREE / GAN_RUN_DIR, not a project-root reconstruction', () => {
    const tpl = renderedTemplate();

    expect(tpl).toContain('GAN_WORKTREE');
    expect(tpl).toContain('GAN_RUN_DIR');

    expect(tpl).not.toContain('.gan-state/runs/$GAN_RUN_ID/worktree');
    expect(tpl).not.toContain('.gan-state/runs/${GAN_RUN_ID}/worktree');

    const codeLines = tpl
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'));
    for (const line of codeLines) {
      expect(line, `unexpected eval in: ${line}`).not.toMatch(/\beval\b/);
    }

    const inputVars = ['GAN_WORKTREE', 'GAN_RUN_DIR', 'GAN_RUN_ID', 'CANDIDATE'];
    for (const line of codeLines) {
      for (const v of inputVars) {

        const re = new RegExp(`(.?)\\$\\{?${v}\\b`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const preceding = m[1];
          expect(
            preceding === '"' || preceding === '/',
            `expansion of $${v} is not inside a quoted span in: ${line}`,
          ).toBe(true);
        }
      }
    }
  });

  it('case-1a: a worktree NOT under CLAUDE_PROJECT_DIR still allows in-worktree writes', () => {
    const sb = makeSandbox();

    const res = runHook(sb, path.join(sb.worktree, 'src', 'app.ts'), fixture.runId, sb.worktree);
    expect(res.exitCode, `case-1a allow\nstderr: ${res.stderr}`).toBe(0);
  });

  for (const c of fixture.cases) {
    it(`${c.expect.toUpperCase()}: ${c.name}`, () => {
      const sb = makeSandbox();
      const candidate = expand(c.path, sb);
      const res = runHook(sb, candidate, fixture.runId, sb.worktree);
      if (c.expect === 'allow') {
        expect(res.exitCode, `${c.name} — ${c.why}\nstderr: ${res.stderr}`).toBe(0);
      } else {
        expect(res.exitCode, `${c.name} — ${c.why}`).not.toBe(0);

        expect(res.stderr).toContain('gan-confine:');
      }
    });
  }
});

describe('F7 security regression gate: adversarial cases (committed, not ad hoc)', () => {
  for (const c of fixture.security) {
    it(`${c.expect.toUpperCase()}: ${c.name}`, () => {
      const sb = makeSandbox();
      const effectiveRunId = c.unsetRunId ? undefined : expand(c.runId ?? fixture.runId, sb);
      const effectiveWorktree = c.worktree !== undefined ? expand(c.worktree, sb) : sb.worktree;
      const candidate = expand(c.path, sb);

      const res = runHook(sb, candidate, effectiveRunId, effectiveWorktree);

      if (c.expect === 'allow') {
        expect(res.exitCode, `${c.name} — ${c.why}\nstderr: ${res.stderr}`).toBe(0);
      } else {
        expect(res.exitCode, `${c.name} — ${c.why}`).not.toBe(0);
      }

      if (c.assertNoCanary) {
        expect(existsSync(sb.canary), `${c.name}: canary must NOT exist`).toBe(false);
      }
    });
  }

  it('no injection-bait case anywhere in the matrix ever creates its canary', () => {

    const sb = makeSandbox();
    const baitCases = [...fixture.cases, ...fixture.security].filter(
      (c) => c.path.includes('{canary}') || (c.runId ?? '').includes('{canary}') || (c.worktree ?? '').includes('{canary}'),
    );
    expect(baitCases.length).toBeGreaterThan(0);
    for (const c of baitCases) {
      const effectiveRunId = c.unsetRunId ? undefined : expand(c.runId ?? fixture.runId, sb);
      const effectiveWorktree = c.worktree !== undefined ? expand(c.worktree, sb) : sb.worktree;
      const candidate = expand(c.path, sb);
      runHook(sb, candidate, effectiveRunId, effectiveWorktree);
    }
    expect(existsSync(sb.canary)).toBe(false);
  });
});

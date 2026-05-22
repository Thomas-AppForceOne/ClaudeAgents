/**
 * F7 slice-3 behavioral path-matrix + security regression gate (extends the
 * H1 sprint-5 AC-A10 harness in place).
 *
 * This file closes the F7 confinement-hook supersession as committed
 * automation. It renders the source-of-truth template (substituting
 * __GAN_FRAMEWORK_VERSION__ from package.json, exactly as confineHook.test.ts
 * already does) to an executable hook in a sandbox, then for every entry in
 * `tests/fixtures/hooks/confine-paths.json` spawns the hook with
 *   - GAN_RUN_ID set to a valid O2 run-id (or unset/hostile per the entry),
 *   - GAN_WORKTREE / GAN_RUN_DIR exported as the two F7 allow zones (sandbox
 *     directories, NOT a project-root reconstruction; the worktree is
 *     deliberately placed OUTSIDE the sandbox project root so the case-1a
 *     user-owned worktree is exercised),
 *   - the candidate path fed as PreToolUse stdin JSON (tool_input.file_path),
 * and asserts exit 0 for `allow` entries and a non-zero exit for `deny`
 * entries. The verdicts are READ from the fixture (data-driven, not inlined),
 * so a future zone rework edits the one table.
 *
 * The `security[]` block encodes the adversarial regression cases as committed
 * tests: a hostile/malformed GAN_RUN_ID or GAN_WORKTREE (slash, `..`, glob,
 * shell metacharacters, `$(...)`) is denied rather than widening the allow
 * zone; a boundary-aware sibling-prefix path (`<worktree>x`) is denied; a `..`
 * traversal escaping the worktree/run-dir is denied; an injection-bait
 * candidate path (containing `$(touch CANARY)` / backticks / `; touch CANARY`)
 * is treated strictly as data and creates NO canary file; an unset/empty
 * GAN_RUN_ID no-ops (exit 0).
 *
 * The real `~/.claude/` is never touched: every spawn runs against a sandbox
 * $HOME (makeTmpHome) and sandbox zone directories.
 */
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
  /** Security cases may override the run-id, unset it, or assert no canary. */
  runId?: string;
  unsetRunId?: boolean;
  /** Security cases may override the GAN_WORKTREE zone value (hostile inputs). */
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

/** One rendered, executable hook + a sandbox HOME / zone dirs / canary. */
interface Sandbox {
  hookPath: string;
  home: string;
  /** $GAN_WORKTREE — placed OUTSIDE the project root to exercise case 1a. */
  worktree: string;
  /** $GAN_RUN_DIR — the central-store run dir, also outside the project root. */
  rundir: string;
  canary: string;
}

function makeSandbox(): Sandbox {
  const tmp = makeTmpHome({ withRepo: false });
  cleanups.push(tmp);
  // The two F7 zones are sibling dirs under the sandbox root, deliberately
  // NOT nested under any "project root" — proving the hook sources its zones
  // from the env vars, not from CLAUDE_PROJECT_DIR / PWD.
  const worktree = path.join(tmp.root, 'user-worktree');
  const rundir = path.join(tmp.root, 'store', 'repo-key', 'runs', '20240115T091500-a1b2');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(rundir, { recursive: true });
  const hookPath = path.join(tmp.root, 'gan-confine.sh');
  writeFileSync(hookPath, renderedTemplate());
  chmodSync(hookPath, 0o755);
  return { hookPath, home: tmp.home, worktree, rundir, canary: path.join(tmp.root, 'CANARY') };
}

/**
 * Expand the fixture placeholders ({worktree}, {rundir}, {home}, {canary})
 * for a single value against a sandbox.
 */
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

/**
 * Drive the rendered hook once: feed `candidate` as PreToolUse stdin JSON,
 * with GAN_RUN_ID set (or unset) and GAN_WORKTREE / GAN_RUN_DIR exported as
 * the two F7 zones. CLAUDE_PROJECT_DIR is set to an UNRELATED directory to
 * prove the hook ignores it. Bash itself is resolved from the host so the
 * spawn works under a scrubbed PATH; the stdin parser comes from the
 * inherited PATH.
 */
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
    // A different directory from either zone: the hook must not derive zones
    // from it under F7.
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
    // The spec-named cases are all present and carry the verdict the spec fixes.
    const spec = fixture.cases.filter((c) => c.spec);
    const byVerdict = (v: 'allow' | 'deny') => spec.filter((c) => c.expect === v).map((c) => c.name);
    // worktree allow + declared run-dir artifact allow.
    expect(byVerdict('allow').length).toBeGreaterThanOrEqual(2);
    // ~/.claude deny, .gan-state/modules deny, outside-both-zones deny.
    expect(byVerdict('deny').length).toBeGreaterThanOrEqual(2);
    // Each entry carries enough to drive stdin-JSON-in / exit-code-out.
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
    // F7: the env vars are referenced.
    expect(tpl).toContain('GAN_WORKTREE');
    expect(tpl).toContain('GAN_RUN_DIR');
    // The legacy project-root-anchored worktree literal is gone.
    expect(tpl).not.toContain('.gan-state/runs/$GAN_RUN_ID/worktree');
    expect(tpl).not.toContain('.gan-state/runs/${GAN_RUN_ID}/worktree');
    // No `eval` invocation anywhere (shell-safety static check). We scan the
    // executable lines only — comment lines (which document the never-eval
    // posture) legitimately contain the word "eval".
    const codeLines = tpl
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'));
    for (const line of codeLines) {
      expect(line, `unexpected eval in: ${line}`).not.toMatch(/\beval\b/);
    }
    // Every expansion of the attacker-influenceable inputs is double-quoted.
    // In this template each `$VAR` / `${VAR…}` occurrence sits inside a
    // double-quoted span, so the character immediately before the `$` (or
    // `${`) is always `"` (start of a quoted span) or `/` (a path join inside
    // a quoted span). A bare expansion (preceded by whitespace, `=`, `(`, …)
    // would be a word-splitting / glob hazard and is forbidden.
    const inputVars = ['GAN_WORKTREE', 'GAN_RUN_DIR', 'GAN_RUN_ID', 'CANDIDATE'];
    for (const line of codeLines) {
      for (const v of inputVars) {
        // Match both `$VAR` and `${VAR` forms.
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
    // sb.worktree is under tmp.root, while CLAUDE_PROJECT_DIR is home/project —
    // disjoint trees. A write under the env-sourced worktree must allow.
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
        // A denied write carries a one-line reason on stderr (default-deny
        // posture: the hook explains itself, never a stack trace).
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

      // Injection-bait cases: the candidate path / run-id / worktree is data,
      // never executed — assert the canary side-effect file was NOT created.
      if (c.assertNoCanary) {
        expect(existsSync(sb.canary), `${c.name}: canary must NOT exist`).toBe(false);
      }
    });
  }

  it('no injection-bait case anywhere in the matrix ever creates its canary', () => {
    // Belt-and-braces sweep: run every canary-bearing case (cases + security)
    // in one sandbox and assert the canary stays absent across all of them.
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

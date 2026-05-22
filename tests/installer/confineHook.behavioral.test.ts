/**
 * H1 sprint 5 — AC-A10 behavioral path-matrix + security regression gate.
 *
 * Sprint 1 verified the confine hook's allow/deny matrix MANUALLY (the
 * evaluator re-ran the cases externally and deferred the committed fixture to
 * sprint 5; confineHook.test.ts asserts only hook CONTENT, not behavioral
 * verdicts). This file closes AC-A10 as committed automation: it renders the
 * source-of-truth template (substituting __GAN_FRAMEWORK_VERSION__ from
 * package.json, exactly as confineHook.test.ts already does) to an executable
 * hook in a sandbox, then for every entry in
 * `tests/fixtures/hooks/confine-paths.json` spawns the hook with
 *   - GAN_RUN_ID set to a valid O2 run-id (or unset/hostile per the entry),
 *   - CLAUDE_PROJECT_DIR pointed at a sandbox project root,
 *   - the candidate path fed as PreToolUse stdin JSON (tool_input.file_path),
 * and asserts exit 0 for `allow` entries and a non-zero exit for `deny`
 * entries. The verdicts are READ from the fixture (data-driven, not inlined),
 * so a future F1 zone rework edits the one table.
 *
 * The `security[]` block encodes the adversarial regression cases as committed
 * tests: a hostile/malformed GAN_RUN_ID (slash, `..`, glob, shell
 * metacharacters, `$(...)`) is denied rather than widening the allow zone; a
 * `..` traversal escaping the worktree/run-dir is denied; an injection-bait
 * candidate path (containing `$(touch CANARY)` / backticks / `; touch CANARY`)
 * is treated strictly as data and creates NO canary file; an unset/empty
 * GAN_RUN_ID no-ops (exit 0).
 *
 * The real `~/.claude/` is never touched: every spawn runs against a sandbox
 * $HOME (makeTmpHome) and a sandbox project root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRootDir } from './helpers/spawn.js';
import { makeTmpHome, type TmpHome } from './helpers/tmpenv.js';

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

/** Render the source-of-truth template for the running framework version. */
function renderedTemplate(): string {
  const tpl = readFileSync(
    path.join(repoRootDir(), 'scripts', 'hooks', 'gan-confine.sh.template'),
    'utf8',
  );
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(packageVersion());
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

/** One rendered, executable hook + a sandbox HOME / project-root / canary. */
interface Sandbox {
  hookPath: string;
  home: string;
  root: string;
  canary: string;
}

function makeSandbox(): Sandbox {
  const tmp = makeTmpHome({ withRepo: false });
  cleanups.push(tmp);
  const root = path.join(tmp.root, 'project');
  mkdirSync(root, { recursive: true });
  const hookPath = path.join(tmp.root, 'gan-confine.sh');
  writeFileSync(hookPath, renderedTemplate());
  chmodSync(hookPath, 0o755);
  return { hookPath, home: tmp.home, root, canary: path.join(tmp.root, 'CANARY') };
}

/**
 * Expand the fixture placeholders ({run}, {root}, {home}, {canary}) for a
 * single case against a sandbox + the effective run-id.
 */
function expand(value: string, sb: Sandbox, runId: string): string {
  return value
    .split('{run}')
    .join(runId)
    .split('{root}')
    .join(sb.root)
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
 * with GAN_RUN_ID set (or unset) and CLAUDE_PROJECT_DIR at the sandbox root.
 * Bash itself is resolved from the host so the spawn works under a scrubbed
 * PATH; node (the hook's stdin parser) comes from the inherited PATH.
 */
function runHook(sb: Sandbox, candidate: string, runId: string | undefined): HookResult {
  const stdin = JSON.stringify({ tool_input: { file_path: candidate } });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: sb.home,
    CLAUDE_PROJECT_DIR: sb.root,
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

describe('AC-A10: confine hook behavioral path matrix (data-driven from confine-paths.json)', () => {
  it('the fixture is valid JSON, covers the four spec cases, and is read (not re-derived)', () => {
    expect(Array.isArray(fixture.cases)).toBe(true);
    expect(fixture.cases.length).toBeGreaterThan(0);
    // The four spec-named cases (AC-A10 / spec line 179) are all present and
    // carry the verdict the spec fixes.
    const spec = fixture.cases.filter((c) => c.spec);
    const byVerdict = (v: 'allow' | 'deny') => spec.filter((c) => c.expect === v).map((c) => c.name);
    // worktree allow.
    expect(byVerdict('allow').length).toBeGreaterThanOrEqual(1);
    // ~/.claude deny, .gan-state/modules deny, project-root-outside-zones deny.
    expect(byVerdict('deny').length).toBeGreaterThanOrEqual(3);
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

  for (const c of fixture.cases) {
    it(`${c.expect.toUpperCase()}: ${c.name}`, () => {
      const sb = makeSandbox();
      const candidate = expand(c.path, sb, fixture.runId);
      const res = runHook(sb, candidate, fixture.runId);
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

describe('AC-A10 security regression gate: adversarial cases (committed, not ad hoc)', () => {
  for (const c of fixture.security) {
    it(`${c.expect.toUpperCase()}: ${c.name}`, () => {
      const sb = makeSandbox();
      const effectiveRunId = c.unsetRunId
        ? undefined
        : expand(c.runId ?? fixture.runId, sb, fixture.runId);
      const candidate = expand(c.path, sb, fixture.runId);

      const res = runHook(sb, candidate, effectiveRunId);

      if (c.expect === 'allow') {
        expect(res.exitCode, `${c.name} — ${c.why}\nstderr: ${res.stderr}`).toBe(0);
      } else {
        expect(res.exitCode, `${c.name} — ${c.why}`).not.toBe(0);
      }

      // Injection-bait cases: the candidate path / run-id is data, never
      // executed — assert the canary side-effect file was NOT created.
      if (c.assertNoCanary) {
        expect(existsSync(sb.canary), `${c.name}: canary must NOT exist`).toBe(false);
      }
    });
  }

  it('no injection-bait case anywhere in the matrix ever creates its canary', () => {
    // Belt-and-braces sweep: run every canary-bearing case (cases + security)
    // in one sandbox and assert the canary stays absent across all of them.
    const sb = makeSandbox();
    const baitCases = [...fixture.cases, ...fixture.security].filter((c) =>
      c.path.includes('{canary}'),
    );
    expect(baitCases.length).toBeGreaterThan(0);
    for (const c of baitCases) {
      const effectiveRunId = c.unsetRunId
        ? undefined
        : expand(c.runId ?? fixture.runId, sb, fixture.runId);
      const candidate = expand(c.path, sb, fixture.runId);
      runHook(sb, candidate, effectiveRunId);
    }
    expect(existsSync(sb.canary)).toBe(false);
  });
});

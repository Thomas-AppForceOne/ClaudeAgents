/**
 * H1 hook coverage for the BR-004 canonical evaluator-output filename (Q10).
 *
 * The H1 confinement hook is the framework's per-sprint trust boundary; the
 * Q10 canonicalisation work tightens the deny coverage around the evaluator's
 * per-attempt artefact so a non-canonical filename surfaces with an explicit
 * deny instead of falling through the default-deny at the end of the hook.
 * This suite spawns the version-rendered hook (the same artefact `install.sh`
 * writes to the user's `~/.claude/hooks/gan-confine.sh`) and feeds it the
 * exact PreToolUse JSON Claude Code feeds it, with `GAN_RUN_ID` and the two
 * zone env vars set so the hook is in its active-confinement mode.
 *
 * Why these four cases: each non-canonical variant maps to a real run on disk
 * — `-evidence-A.json` (original E8 run), `-evaluator-evidence-A.json` (M4),
 * `-evaluation.json` (O1) — and the canonical form `-feedback-A.json` is what
 * `agents/gan-evaluator.md` and `skills/gan/SKILL.md` have already named.
 * The deny coverage prevents an LLM drift back to any of the three variants
 * from silently producing coexisting artefacts under the same run dir.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { makeTmpHome, type TmpHome } from './helpers/tmpenv.js';
import { renderedTemplate } from './helpers/confineTemplate.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

/**
 * Sandbox holding the rendered hook plus the two zone directories the hook
 * reads from the environment. The run-dir absolute path becomes the hook's
 * `$GAN_RUN_DIR`; the worktree path becomes `$GAN_WORKTREE`.
 */
interface Sandbox {
  hookPath: string;
  worktree: string;
  rundir: string;
  home: string;
}

// Build a hermetic sandbox under a temp home: render the hook from the source
// template (so the test exercises the same bytes install.sh will ship), and
// create the two zone directories the hook expects to exist.
function makeSandbox(): Sandbox {
  const tmp = makeTmpHome({ withRepo: false });
  cleanups.push(tmp);

  const worktree = path.join(tmp.root, 'user-worktree');
  const rundir = path.join(tmp.root, 'store', 'repo-key', 'runs', '20260609T194234-1bdd');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(rundir, { recursive: true });

  const hookPath = path.join(tmp.root, 'gan-confine.sh');
  writeFileSync(hookPath, renderedTemplate());
  chmodSync(hookPath, 0o755);
  return { hookPath, worktree, rundir, home: tmp.home };
}

interface HookResult {
  exitCode: number;
  stderr: string;
}

// Invoke the hook the same way Claude Code does: a JSON `{tool_input:
// {file_path}}` envelope on stdin. The candidate path arrives as an absolute
// path under the rundir so the hook's REL computation runs against the
// declared run-dir artifact set.
function runHook(sb: Sandbox, candidate: string): HookResult {
  const stdin = JSON.stringify({ tool_input: { file_path: candidate } });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: sb.home,
    GAN_RUN_ID: '20260609T194234-1bdd',
    GAN_WORKTREE: sb.worktree,
    GAN_RUN_DIR: sb.rundir,
  };
  const res = spawnSync('/bin/bash', [sb.hookPath], { input: stdin, env, encoding: 'utf8' });
  return { exitCode: res.status ?? 1, stderr: res.stderr ?? '' };
}

describe('Q10 — H1 hook denies non-canonical evaluator-output filenames', () => {
  it('allows the canonical sprint-1-feedback-A.json directly under the run dir', () => {
    const sb = makeSandbox();
    const res = runHook(sb, path.join(sb.rundir, 'sprint-1-feedback-A.json'));
    expect(res.exitCode, `canonical name allowed\nstderr: ${res.stderr}`).toBe(0);
  });

  it('denies sprint-1-evidence-A.json (original E8-run variant) with a named-deny message', () => {
    const sb = makeSandbox();
    const res = runHook(sb, path.join(sb.rundir, 'sprint-1-evidence-A.json'));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('non-canonical evaluator-output filename');
    expect(res.stderr).toContain('sprint-N-feedback-A.json');
  });

  it('denies sprint-1-evaluator-evidence-A.json (M4-run variant) with a named-deny message', () => {
    const sb = makeSandbox();
    const res = runHook(sb, path.join(sb.rundir, 'sprint-1-evaluator-evidence-A.json'));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('non-canonical evaluator-output filename');
    expect(res.stderr).toContain('sprint-N-feedback-A.json');
  });

  it('denies sprint-1-evaluation.json (O1-run variant) with a named-deny message', () => {
    const sb = makeSandbox();
    const res = runHook(sb, path.join(sb.rundir, 'sprint-1-evaluation.json'));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('non-canonical evaluator-output filename');
    expect(res.stderr).toContain('sprint-N-feedback-A.json');
  });

  it('denies the literal-N template form sprint-N-feedback-A.json (the canonical glob requires a digit run for N)', () => {
    const sb = makeSandbox();
    const res = runHook(sb, path.join(sb.rundir, 'sprint-N-feedback-A.json'));

    // Falls through to the default-deny since N is not [0-9]*; the test pins
    // the rejection itself, not the specific message text.
    expect(res.exitCode).not.toBe(0);
  });
});

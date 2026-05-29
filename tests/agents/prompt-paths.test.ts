/**
 * Agent-prompt path discipline — every reachable run-*data* write in the five
 * orchestrated agent prompts (proposer, reviewer, generator, evaluator,
 * planner) must address the central-store run dir (the orchestrator-exported
 * GAN_RUN_DIR), not the pre-F7 project-local `.gan-state/runs/<run-id>/`
 * literal that the H1 confinement hook now denies. The project-local
 * `.gan-state/runs/<run-id>/worktree/` subtree (i.e. GAN_WORKTREE) is
 * intentionally exempt — that path is where the generator and evaluator do
 * their actual work, and the hook explicitly allows it.
 *
 * The clarifier prompt is **not** in scope for this sweep — it already
 * phrases this abstractly ("under the run directory") and needs no edit;
 * the byte-level regression guard at the end of the suite asserts the sweep
 * left it untouched against develop.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// The five prompts the sprint sweeps. Clarifier intentionally absent — it
// is the byte-level regression target in the final block, not a sweep
// target.
const SWEEP_PROMPTS = [
  'agents/gan-contract-proposer.md',
  'agents/gan-contract-reviewer.md',
  'agents/gan-generator.md',
  'agents/gan-evaluator.md',
  'agents/gan-planner.md',
] as const;

describe('agent prompt F7-path sweep', () => {
  for (const rel of SWEEP_PROMPTS) {
    describe(rel, () => {
      const abs = path.join(repoRoot, rel);
      const body = readFileSync(abs, 'utf8');

      it('every .gan-state/runs/ occurrence is followed by <id>/worktree (project-local worktree only)', () => {
        // Deterministic string-walk over the prompt: every reference to the
        // legacy data-path prefix must be the worktree sub-path, the one
        // path the H1 confinement hook still allows for project-local
        // writes. Any other suffix is a residual pre-F7 data-path that
        // would land in a denied zone at runtime.
        const parts = body.split('.gan-state/runs/');
        for (let i = 1; i < parts.length; i += 1) {
          const chunk = parts[i] ?? '';
          const slash = chunk.indexOf('/');
          expect(
            slash,
            `occurrence ${i} has no '/' separator: ${chunk.slice(0, 80)}`,
          ).toBeGreaterThan(-1);
          const afterSegment = chunk.slice(slash + 1);
          expect(
            afterSegment.startsWith('worktree'),
            `occurrence ${i} in ${rel} not followed by '<id>/worktree': ${chunk.slice(0, 80)}`,
          ).toBe(true);
        }
      });

      it('mentions GAN_RUN_DIR — run-data writes go through the env var, not a hardcoded path', () => {
        // The prompts no longer name a literal data-path, so they must name
        // the env var that exports the resolved run dir. The agent reads
        // the value at spawn time from its environment.
        expect(body).toMatch(/GAN_RUN_DIR/);
      });
    });
  }

  // Two prompts retain a `.gan-state/runs/<run-id>/worktree` reference under
  // GAN_WORKTREE — the worktree path the generator and evaluator work
  // inside. That is the H1-allowed zone the sweep deliberately preserves;
  // a sweep that scrubbed it would break the documented worktree contract.
  it('worktree references survive in the prompts that need them (regression guard)', () => {
    const generatorBody = readFileSync(
      path.join(repoRoot, 'agents/gan-generator.md'),
      'utf8',
    );
    const evaluatorBody = readFileSync(
      path.join(repoRoot, 'agents/gan-evaluator.md'),
      'utf8',
    );
    expect(generatorBody).toMatch(/\.gan-state\/runs\/<run-id>\/worktree/);
    expect(evaluatorBody).toMatch(/\.gan-state\/runs\/<run-id>\/worktree/);
    // Both prompts also name GAN_WORKTREE, the env-var form of the same path.
    expect(generatorBody).toContain('GAN_WORKTREE');
    expect(evaluatorBody).toContain('GAN_WORKTREE');
  });

  // The clarifier prompt was already abstract before this sweep ("under the
  // run directory"); the implementing PR must leave it byte-identical
  // against develop. `git diff develop --` returns the empty string when no
  // change is present; any output here means the sweep over-applied to the
  // clarifier.
  it('clarifier prompt is byte-identical against develop (not in the sweep)', () => {
    let diff: string;
    try {
      diff = execFileSync(
        'git',
        ['diff', 'develop', '--', 'agents/gan-clarifier.md'],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      // A missing `develop` branch (rare on a CI checkout) makes the
      // assertion unenforceable; skip rather than fail in that case so the
      // test surface stays runnable on every developer checkout.
      return;
    }
    expect(diff).toBe('');
  });
});

/**
 * GAN skill trace-wiring suite — reads the SHIPPED skills/gan/SKILL.md verbatim
 * and asserts it documents every point where the orchestrator must wire the
 * run-trace library into the loop, so the operational contract stays in the
 * skill that drives the loop, not just in the trace code.
 *
 * It checks a dedicated "Run-trace integration points" section names the four
 * core event classes (orchestratorMilestone / agentAttempt / llmCall /
 * toolCall) and documents five wiring points, each by its helper name:
 * 1. heartbeat (`[<role>] thinking...` via formatHeartbeat) emitted to stderr
 *    before an agent's first LLM call; also the per-call and sprint-end
 *    summary formatters.
 * 2. trustEvent at trust-prompt resolution (buildTrustEventBody), including the
 *    [v]/[a]/[r]/[c] choice keys and the runWithoutProjectCommands outcome.
 * 3. validationAbort on validateAll() abort (buildValidationAbortBody) with the
 *    payload preserved verbatim.
 * 4. `--recover` reconstructing resume sequence + attempt counters
 *    (reconstructRecoveryState) gaplessly, with NO external counter file.
 * 5. the A1 safetyHalt with safetyClass=loopDetected against the reserved
 *    extension point.
 *
 * Boundary discipline: the section must say "the framework" (not a runtime
 * name), state traces are never transmitted off-machine, and — scoped to the
 * region between the section heading and the next `## Spawn discipline` heading
 * — leak no ecosystem-specific tokens (lint-no-stack-leak).
 *
 * The string/regex literals are expected SKILL.md content, not code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');
const skill = readFileSync(skillPath, 'utf8');

describe('skill_documents_runtime_wiring_points', () => {
  it('has a dedicated run-trace integration section', () => {
    expect(skill).toMatch(/##\s+Run-trace integration points/);
  });

  it('documents the orchestrator emitting the four core event classes via the trace library', () => {
    for (const cls of ['orchestratorMilestone', 'agentAttempt', 'llmCall', 'toolCall']) {
      expect(skill, `event class: ${cls}`).toContain(cls);
    }
  });

  it('wiring point 1: heartbeat emits to stderr before the first LLM call, naming formatHeartbeat', () => {
    expect(skill).toContain('[<role>] thinking...');
    expect(skill).toContain('formatHeartbeat');
    expect(skill).toMatch(/before an agent'?s \*\*?first\*\*? LLM call/i);
    expect(skill.toLowerCase()).toContain('stderr');
  });

  it('also documents the per-call and sprint-end summary formatters', () => {
    expect(skill).toContain('formatLlmCallSummary');
    expect(skill).toMatch(/formatSprintSummary/);
  });

  it('wiring point 2: trustEvent at trust-prompt resolution, naming buildTrustEventBody', () => {
    expect(skill).toContain('trustEvent');
    expect(skill).toContain('buildTrustEventBody');

    expect(skill).toMatch(/\[v\].{0,12}\[a\].{0,12}\[r\].{0,12}\[c\]/);
    expect(skill).toContain('runWithoutProjectCommands');
  });

  it('wiring point 3: validationAbort on validateAll() abort, naming buildValidationAbortBody, payload verbatim', () => {
    expect(skill).toContain('validationAbort');
    expect(skill).toContain('buildValidationAbortBody');
    expect(skill).toContain('validateAll()');
    expect(skill.toLowerCase()).toContain('verbatim');
  });

  it('wiring point 4: --recover reads the trace to resume sequence + attempt counters, no external counter file', () => {
    expect(skill).toContain('--recover');
    expect(skill).toContain('reconstructRecoveryState');
    expect(skill).toMatch(/without\b.{0,40}external counter file/i);
    expect(skill.toLowerCase()).toContain('gaplessly');
  });

  it('wiring point 5: A1 safetyHalt with safetyClass=loopDetected against the reserved extension point', () => {
    expect(skill).toContain('safetyHalt');
    expect(skill).toContain('loopDetected');
    expect(skill.toLowerCase()).toContain('reserved');
  });

  it('the run-trace section names the framework, not a runtime, and stays local-only', () => {
    expect(skill).toContain('the framework');
    expect(skill.toLowerCase()).toContain('never transmitted off-machine');
  });

  it('leaks no ecosystem-specific tool tokens (lint-no-stack-leak discipline)', () => {

    const start = skill.indexOf('## Run-trace integration points');
    const end = skill.indexOf('## Spawn discipline', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skill.slice(start, end);
    for (const token of [
      'npm',
      'package.json',
      'package-lock.json',
      'node_modules',
      'pnpm',
      'yarn',
      '.nvmrc',
      'tsconfig.json',
    ]) {
      expect(section, `ecosystem token: ${token}`).not.toContain(token);
    }
  });
});

/**
 * Step-8 / lock-lifecycle / F7-path-sweep checks. The runtime invocation
 * bridge places resolveRunStore + acquireRunLock immediately before the
 * clarifier's step-7 writes (so a second concurrent /gan is refused before it
 * can burn the clarification phase), rewrites the worktree step to call
 * createRunWorkspace and act on resolutionCase / createdByGan, and adds
 * releaseRunLock to every exit path. The string-walk over the entire file
 * pins the F7 data-path sweep: every .gan-state/runs/ occurrence is followed
 * by /worktree, the only project-local sub-path the GAN_WORKTREE env var
 * resolves to.
 */
describe('skill_step_8_calls_createRunWorkspace', () => {
  it('names createRunWorkspace where the orchestrator obtains the worktree', () => {
    expect(skill).toContain('createRunWorkspace');
  });

  it('acts on the returned resolutionCase and createdByGan fields', () => {
    expect(skill).toContain('resolutionCase');
    expect(skill).toContain('createdByGan');
  });

  it('names the three resolution cases (1a / 1b / 1c)', () => {
    // Pinning all three keeps the prose honest about the main-checkout
    // regression fix: a 1c path appearing without 1a would let a
    // misreading still treat 1a as "always reuse".
    expect(skill).toContain("'1a'");
    expect(skill).toContain("'1b'");
    expect(skill).toContain("'1c'");
  });
});

describe('skill_lock_lifecycle_acquire_before_step7_and_release_on_every_exit', () => {
  it('acquireRunLock appears between resolveRunStore and the clarifier-write step inside the regular invocation flow', () => {
    // Scope to the "Regular invocation flow" section — the only place
    // where the lifecycle ordering is load-bearing. A clarified-spec.md
    // mention earlier in the file (e.g. in the flag description, or later
    // in the "Clarification phase" detail section) is unrelated to the
    // flow-step ordering and would mislead the assertion if we used
    // file-wide indexes.
    const flowStart = skill.indexOf('## Regular invocation flow');
    const flowEnd = skill.indexOf('\n## ', flowStart + 1);
    expect(flowStart).toBeGreaterThan(-1);
    expect(flowEnd).toBeGreaterThan(flowStart);
    const flow = skill.slice(flowStart, flowEnd);

    const resolveIdx = flow.indexOf('resolveRunStore');
    const acquireIdx = flow.indexOf('acquireRunLock');
    const clarifiedIdx = flow.indexOf('clarified-spec.md');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(clarifiedIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(resolveIdx);
    expect(acquireIdx).toBeLessThan(clarifiedIdx);
  });

  it('releaseRunLock appears on the tear-down / exit path', () => {
    expect(skill).toContain('releaseRunLock');
    // The release prose explicitly names the abort/error path too, not just
    // graceful completion — the long-lived config-server pid means a
    // stale-break self-heal never fires for an unreleased lock.
    const tearDownIdx = skill.indexOf('Tear down');
    expect(tearDownIdx).toBeGreaterThan(-1);
    const tearDownSection = skill.slice(tearDownIdx, tearDownIdx + 2000);
    expect(tearDownSection).toContain('releaseRunLock');
    expect(tearDownSection.toLowerCase()).toMatch(/abort|error/);
  });
});

describe('skill_no_residual_pre_F7_run_data_paths', () => {
  it('every .gan-state/runs/ occurrence is followed by <id>/worktree (project-local worktree subpath only)', () => {
    // Deterministic string-walk: split on the literal data-path prefix; for
    // every continuation, the next segment must be followed by /worktree.
    // Any other suffix is a residual pre-F7 data-path that needed the sweep.
    const parts = skill.split('.gan-state/runs/');
    // First chunk is everything before the first occurrence — ignored.
    for (let i = 1; i < parts.length; i += 1) {
      const chunk = parts[i] ?? '';
      // The segment is the run-id placeholder up to the first '/'; assert
      // the remainder begins with 'worktree'. Pulling the substring makes the
      // failure message readable.
      const slash = chunk.indexOf('/');
      expect(slash, `chunk ${i} has no '/': ${chunk.slice(0, 80)}`).toBeGreaterThan(-1);
      const afterSegment = chunk.slice(slash + 1);
      expect(
        afterSegment.startsWith('worktree'),
        `.gan-state/runs/ occurrence ${i} not followed by '<id>/worktree': ${chunk.slice(0, 80)}`,
      ).toBe(true);
    }
  });

  it('GAN_RUN_DIR and GAN_WORKTREE literal tokens both appear in the file', () => {
    expect(skill).toContain('GAN_RUN_DIR');
    expect(skill).toContain('GAN_WORKTREE');
  });
});

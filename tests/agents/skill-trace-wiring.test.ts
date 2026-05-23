
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

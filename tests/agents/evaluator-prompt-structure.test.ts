/**
 * T1 Sprint 3 — structure check for the reconciled evaluator prompt (F3.1).
 *
 * Covers contract criterion:
 *  - evaluator_prompt_documents_bundle_shape
 *
 * The shape is schema-pinned (Sprint 1, evaluator-evidence-bundle-v1.json);
 * agents/gan-evaluator.md is the source of truth for HOW the bundle is
 * produced. This test asserts the prompt documents the T1 evidence-bundle
 * shape and the production guidance, that the legacy
 * {passed, feedback[], blockingConcerns[], overallSummary} prose is gone, and
 * that the prose carries no repo-internal process leak or ecosystem tool
 * tokens (lint-no-stack-leak / error-text discipline).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-evaluator.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('evaluator_prompt_documents_bundle_shape', () => {
  it('writes the artifact to the attempt-letter feedback path', () => {
    expect(prompt).toContain('.gan-state/runs/<run-id>/sprint-{N}-feedback-{attempt-letter}.json');
  });

  it('documents the T1 evidence-bundle top-level shape', () => {
    for (const token of ['sprintNumber', 'attemptLetter', 'criteria', 'verdictSummary']) {
      expect(prompt, `top-level field: ${token}`).toContain(token);
    }
  });

  it('documents the per-criterion fields', () => {
    for (const token of [
      'name',
      'verdict',
      'traceEventRefs',
      'reproductionCommand',
      'deltaFromContract',
      'expected',
      'observed',
    ]) {
      expect(prompt, `per-criterion field: ${token}`).toContain(token);
    }
  });

  it('documents the four verdict values', () => {
    for (const v of ['"pass"', '"fail"', '"blocked"', '"skipped"']) {
      expect(prompt, `verdict: ${v}`).toContain(v);
    }
  });

  it('documents the join key against the contract criterion name', () => {
    expect(prompt.toLowerCase()).toContain('join key');
    expect(prompt).toMatch(/match(es)? a criterion `?name`? in the (corresponding )?sprint contract/i);
  });

  it('documents how to gather traceEventRefs as <eventType>:<sequenceNumber>', () => {
    expect(prompt).toContain('<eventType>:<sequenceNumber>');
    expect(prompt).toContain('trace/');
  });

  it('documents choosing a deterministic reproductionCommand', () => {
    expect(prompt.toLowerCase()).toContain('deterministic');
    expect(prompt).toMatch(/reproductionCommand/);
  });

  it('documents filling deltaFromContract (expected paraphrases description, observed is what was found)', () => {
    expect(prompt).toMatch(/`expected` paraphrases the criterion'?s `?description`?/i);
    expect(prompt).toMatch(/`observed` is what you (actually )?found/i);
  });

  it('documents that a fail verdict carries BOTH reproductionCommand and deltaFromContract', () => {
    expect(prompt).toMatch(
      /verdict = "fail".{0,80}(both|MUST carry).{0,120}reproductionCommand.{0,60}deltaFromContract/is,
    );
  });

  it('does NOT carry the legacy feedback-artifact shape', () => {
    // The legacy top-level keys must be gone from the documented output shape.
    expect(prompt).not.toContain('"overallSummary"');
    expect(prompt).not.toContain('overallSummary');
    expect(prompt).not.toContain('blockingConcerns');
    // The legacy per-entry score map shape.
    expect(prompt).not.toContain('"criterion": "criterion_name"');
  });

  it('preserves the evaluator-core plan-consumption guidance', () => {
    expect(prompt).toContain('evaluator-core');
    expect(prompt.toLowerCase()).toContain('plan');
  });

  it('preserves the scoring discipline (1-10 against the per-criterion threshold)', () => {
    expect(prompt).toContain('threshold');
    expect(prompt).toMatch(/1.?10/); // the 1-10 scale
  });

  it('leaks no repo-internal process references', () => {
    for (const token of ['roadmap.md', 'PROJECT_CONTEXT', 'specifications/', 'CLAUDE.md']) {
      expect(prompt, `repo-internal leak: ${token}`).not.toContain(token);
    }
  });

  it('leaks no ecosystem-specific tool tokens (lint-no-stack-leak discipline)', () => {
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
      expect(prompt, `ecosystem token: ${token}`).not.toContain(token);
    }
  });
});

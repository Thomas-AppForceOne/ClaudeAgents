
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

    expect(prompt).not.toContain('"overallSummary"');
    expect(prompt).not.toContain('overallSummary');
    expect(prompt).not.toContain('blockingConcerns');

    expect(prompt).not.toContain('"criterion": "criterion_name"');
  });

  it('preserves the evaluator-core plan-consumption guidance', () => {
    expect(prompt).toContain('evaluator-core');
    expect(prompt.toLowerCase()).toContain('plan');
  });

  it('preserves the scoring discipline (1-10 against the per-criterion threshold)', () => {
    expect(prompt).toContain('threshold');
    expect(prompt).toMatch(/1.?10/);
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

function docLintBullet(): string {
  const marker = '`snapshot.activeStacks[*].docLintCmd`';
  const start = prompt.indexOf(marker);
  expect(start, 'docLintCmd snapshot-input bullet must exist').toBeGreaterThan(-1);
  const rest = prompt.slice(start);

  const nextField = rest.indexOf('- `snapshot.activeStacks[*].testCmd`');
  return nextField === -1 ? rest : rest.slice(0, nextField);
}

describe('evaluator_prompt_documents_doc_lint_snapshot_input (BEH-1/BEH-3 prompt layer)', () => {
  it('the snapshot-input list gains a docLintCmd bullet', () => {
    expect(prompt).toContain('`snapshot.activeStacks[*].docLintCmd`');
  });

  it('BEH-1 — the bullet instructs absence-tolerance parallel to auditCmd (warn, do not fail for absence alone)', () => {
    const bullet = docLintBullet();
    expect(bullet).toContain('absenceSignal');
    expect(bullet).toContain('absenceMessage');

    expect(bullet.toLowerCase()).toContain('warning');

    expect(bullet).toMatch(/do (\*\*)?not(\*\*)? score the documentation criterion as failed/i);

    expect(bullet.toLowerCase()).toContain('remainder of the plan');
  });

  it('BEH-2 — the bullet documents the baseline delta-vs-absolute semantics', () => {
    const bullet = docLintBullet();
    expect(bullet).toContain('baseline');
    expect(bullet).toContain('delta');
    expect(bullet).toContain('absolute');

    expect(bullet.toLowerCase()).toContain('base ref');
  });

  it('BEH-3 — the bullet documents the severity gates-or-warns routing', () => {
    const bullet = docLintBullet();
    expect(bullet).toContain('severity');

    expect(bullet).toMatch(/blocker.{0,40}fail/i);
    expect(bullet).toMatch(/warning.{0,60}record/i);
    expect(bullet).toMatch(/advisory.{0,80}never block/i);
  });

  it('BEH-3 — the bullet states layer-(c) documentation criteria gate through the existing per-criterion path', () => {
    const bullet = docLintBullet();
    expect(bullet.toLowerCase()).toContain('per-criterion');
    expect(bullet).toMatch(/below its `?threshold`?/i);
    expect(bullet).toMatch(/no special-casing/i);
  });

  it('FUNC-4 — the Deterministic core plan-coverage list gains a per-stack doc-lint line', () => {
    expect(prompt).toMatch(/Per-stack doc-lint invocations/i);
  });

  it('HYG-1 — the docLintCmd bullet restates no documentation-standard prose and carries no ecosystem token', () => {
    const bullet = docLintBullet();

    expect(bullet.toLowerCase()).not.toContain("parameter's meaning");
    expect(bullet.toLowerCase()).not.toContain('doc comment');

    for (const token of ['npm', 'doc-lint', 'package.json', 'pnpm', 'yarn']) {
      expect(bullet, `ecosystem token in docLintCmd bullet: ${token}`).not.toContain(token);
    }
  });
});

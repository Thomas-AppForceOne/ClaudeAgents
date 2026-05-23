

import { describe, expect, it } from 'vitest';

import {
  buildDocLintInvocations,
  buildEvaluatorPlan,
} from '../../../src/agents/evaluator-core/index.js';
import type {
  EvaluatorCoreSnapshot,
  SprintPlan,
  WorktreeState,
} from '../../../src/agents/evaluator-core/index.js';

function declaringStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'web-node',
    scope: ['**/*.ts', '**/*.tsx'],
    docLintCmd: {
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'No documentation linter is configured for this stack.',
      severity: 'blocker',
      baseline: 'delta',
    },
  };
}

function nonDeclaringStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'generic',
    scope: ['**/*'],
  };
}

function declaringStackNoBaseline(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'synthetic-second',
    scope: ['synthetic/**'],
    docLintCmd: {
      command: 'run-synthetic-doc-lint',
      absenceSignal: 'silent',
      severity: 'advisory',
      // baseline intentionally omitted — emission must fill `delta`.
    },
  };
}

const NO_SPRINT: SprintPlan = { affectedFiles: [], criteria: [] };
const NO_WORKTREE: WorktreeState = { files: [] };

describe('buildDocLintInvocations (FUNC-1/FUNC-3 plan emission)', () => {
  it('one per declaring stack, none without field — emits exactly one row keyed to the declaring stack', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack(), nonDeclaringStack()],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    expect(rows.length).toBe(1);
    expect(rows[0]!.stack).toBe('web-node');

    expect(rows.some((r) => r.stack === 'generic')).toBe(false);
  });

  it('none without field — a snapshot with no declaring stack yields an empty array', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [nonDeclaringStack()],
      mergedSplicePoints: {},
    };
    expect(buildDocLintInvocations(snapshot)).toEqual([]);
  });

  it('scope — the row carries the OWNING stack scope, never another stack scope', () => {
    const snapshot: EvaluatorCoreSnapshot = {

      activeStacks: [declaringStack(), declaringStackNoBaseline()],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    const web = rows.find((r) => r.stack === 'web-node')!;
    const syn = rows.find((r) => r.stack === 'synthetic-second')!;

    expect(web.scope).toEqual(['**/*.ts', '**/*.tsx']);
    expect(syn.scope).toEqual(['synthetic/**']);
    expect(web.scope).not.toContain('synthetic/**');
    expect(syn.scope).not.toContain('**/*.ts');
  });

  it('carried — command/severity/baseline/absenceSignal are copied verbatim from the stack field', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack()],
      mergedSplicePoints: {},
    };

    const [row] = buildDocLintInvocations(snapshot);

    expect(row).toEqual({
      stack: 'web-node',
      command: 'run-doc-lint',
      scope: ['**/*.ts', '**/*.tsx'],
      severity: 'blocker',
      baseline: 'delta',
      absenceSignal: 'warning',
    });
  });

  it('baseline — a stack that omits baseline yields the `delta` default at emission', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStackNoBaseline()],
      mergedSplicePoints: {},
    };

    const [row] = buildDocLintInvocations(snapshot);

    expect(row!.baseline).toBe('delta');

    expect(row!.severity).toBe('advisory');
    expect(row!.absenceSignal).toBe('silent');
    expect(row!.command).toBe('run-synthetic-doc-lint');
  });

  it('severity — distinct severities are carried per stack, not normalised', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack(), declaringStackNoBaseline()],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    expect(rows.find((r) => r.stack === 'web-node')!.severity).toBe('blocker');
    expect(rows.find((r) => r.stack === 'synthetic-second')!.severity).toBe('advisory');
  });

  it('absence — the carve-out performs NO absence detection and consults no worktree/diff input', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack()],
      mergedSplicePoints: {},
    };

    const [row] = buildDocLintInvocations(snapshot);
    expect(row!.absenceSignal).toBe('warning');

    expect(buildDocLintInvocations.length).toBe(1);
  });

  it('deterministic — output is sorted by stack and byte-identical across calls', () => {
    const snapshot: EvaluatorCoreSnapshot = {

      activeStacks: [declaringStack(), declaringStackNoBaseline(), nonDeclaringStack()],
      mergedSplicePoints: {},
    };

    const a = buildDocLintInvocations(snapshot);
    const b = buildDocLintInvocations(snapshot);

    expect(a.map((r) => r.stack)).toEqual(['synthetic-second', 'web-node']);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildEvaluatorPlan wires docLintInvocations (FUNC-4)', () => {
  it('plan-builder wires — the assembled plan carries a docLintInvocations array', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack(), nonDeclaringStack()],
      mergedSplicePoints: {},
    };

    const plan = buildEvaluatorPlan(snapshot, NO_SPRINT, NO_WORKTREE);

    expect(Array.isArray(plan.docLintInvocations)).toBe(true);

    expect(plan.docLintInvocations).toEqual(buildDocLintInvocations(snapshot));
    expect(plan.docLintInvocations.map((r) => r.stack)).toEqual(['web-node']);
  });

  it('plan-builder wires — an empty active set yields an empty docLintInvocations array', () => {
    const plan = buildEvaluatorPlan(
      { activeStacks: [], mergedSplicePoints: {} },
      NO_SPRINT,
      NO_WORKTREE,
    );
    expect(plan.docLintInvocations).toEqual([]);
  });
});

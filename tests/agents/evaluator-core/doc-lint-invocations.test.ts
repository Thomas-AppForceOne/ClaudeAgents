/**
 * Q5 Sprint 3 — `docLintInvocations` pure-core emission tests.
 *
 * Exercises `buildDocLintInvocations` (and its wiring through
 * `buildEvaluatorPlan`) as a pure mapping over the snapshot, mirroring the
 * `auditCommands` coverage. These are the FUNC-1 / FUNC-3 / FUNC-4
 * plan-emission criteria: one row per declaring stack, none for a stack
 * without the field, scope/severity/baseline/absenceSignal carried verbatim,
 * the `delta` default applied at emission, and `stack`-sorted byte-stable
 * output. The *behaviour* (absence-tolerance, delta-vs-absolute comparison,
 * severity routing) is intentionally NOT asserted here — that lives
 * downstream at the evaluator-prompt layer (see
 * `doc-lint-execution-semantics.test.ts`), because the carve-out carries no
 * git base ref and runs no command.
 *
 * Test naming is load-bearing: the discriminator greps for the labels
 * 'one per declaring stack', 'none without field', 'scope', 'severity',
 * 'baseline', 'absence', 'carried', 'deterministic', 'plan-builder wires'.
 */

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

// ---- Fixture helpers ----------------------------------------------------

/**
 * A stack declaring a full `docLintCmd` (severity blocker, baseline delta,
 * absenceSignal warning) — the live web-node default shape.
 */
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

/**
 * A stack with NO `docLintCmd` — must contribute zero rows. Models the
 * `generic` fallback, which ships documentation surfaces but omits the
 * deterministic doc-lint tool.
 */
function nonDeclaringStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'generic',
    scope: ['**/*'],
  };
}

/**
 * A second declaring stack whose `docLintCmd` OMITS `baseline`, so the
 * emission-time `delta` default is exercised, and whose scope is disjoint
 * from web-node's, so the per-row scope isolation is observable.
 */
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

// ---- Tests --------------------------------------------------------------

describe('buildDocLintInvocations (FUNC-1/FUNC-3 plan emission)', () => {
  it('one per declaring stack, none without field — emits exactly one row keyed to the declaring stack', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [declaringStack(), nonDeclaringStack()],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    // Exactly one row, for the declaring stack only.
    expect(rows.length).toBe(1);
    expect(rows[0]!.stack).toBe('web-node');
    // Zero rows reference the non-declaring stack.
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
      // Two declaring stacks with disjoint scopes.
      activeStacks: [declaringStack(), declaringStackNoBaseline()],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    const web = rows.find((r) => r.stack === 'web-node')!;
    const syn = rows.find((r) => r.stack === 'synthetic-second')!;
    // Each row's scope is its own stack's scope — no cross-bleed.
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

    // The stack omitted `baseline`; the emitted row carries `delta`.
    expect(row!.baseline).toBe('delta');
    // The other carried values are still verbatim.
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

    // The function signature takes only the snapshot — no WorktreeState, no
    // base ref. The row carries `absenceSignal` for the downstream layer
    // but the carve-out itself never determines whether the tool is absent.
    const [row] = buildDocLintInvocations(snapshot);
    expect(row!.absenceSignal).toBe('warning');
    // buildDocLintInvocations is unary: it cannot see a worktree or a diff.
    expect(buildDocLintInvocations.length).toBe(1);
  });

  it('deterministic — output is sorted by stack and byte-identical across calls', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      // Intentionally NOT in name order to exercise the sort.
      activeStacks: [declaringStack(), declaringStackNoBaseline(), nonDeclaringStack()],
      mergedSplicePoints: {},
    };

    const a = buildDocLintInvocations(snapshot);
    const b = buildDocLintInvocations(snapshot);

    // Sorted by stack: synthetic-second before web-node.
    expect(a.map((r) => r.stack)).toEqual(['synthetic-second', 'web-node']);
    // Byte-stable across calls (the strict E3 contract).
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
    // The wired array equals the standalone helper's output (same source).
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

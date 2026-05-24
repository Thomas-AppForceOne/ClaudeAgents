/**
 * buildDocLintInvocations emission suite (FUNC-1/FUNC-3/FUNC-4) — pins how the
 * evaluator-core deterministic plan derives its per-stack doc-lint rows from a
 * snapshot's active stacks. (Execution semantics of an emitted row are tested
 * separately in doc-lint-execution-semantics.)
 *
 * Emission contract:
 * - one row per stack that DECLARES a docLintCmd, none for a stack without the
 *   field (a non-declaring stack contributes nothing).
 * - each row carries its OWNING stack's scope/command/severity/baseline/
 *   absenceSignal copied verbatim — never another stack's scope, and severities
 *   are kept distinct per stack, not normalised.
 * - `baseline` is the one defaulted field: a stack that omits it gets `delta`
 *   filled at emission, while its other fields stay as declared.
 * - the carve-out does NO absence detection and consults no worktree/diff input
 *   (asserted via the function's arity), keeping emission a pure projection of
 *   the snapshot.
 * - output is deterministic: sorted by stack name and byte-identical across
 *   repeated calls.
 *
 * The final block (FUNC-4) proves buildEvaluatorPlan wires this array onto the
 * assembled plan, equal to calling buildDocLintInvocations directly, and empty
 * when there are no active stacks.
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

    // Arity of exactly 1 proves emission is a pure projection of the snapshot:
    // it takes no worktree/diff argument, so it cannot perform absence detection.
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

/**
 * Q6 Sprint-2 resolution proof: inside `/gan`, the active `web-node` stack's
 * declared `docLintCmd` must resolve through buildDocLintInvocations — and on
 * through buildEvaluatorPlan into `plan.docLintInvocations` — to the real
 * `npm run doc-lint` command the tool ships behind, with web-node's TypeScript
 * scope globs (a copy, not an alias), `blocker` severity, `delta` baseline, and
 * `warning` absence signal.
 *
 * The stack here mirrors the resolved snapshot's `byName['web-node'].docLintCmd`
 * (stacks/web-node.md). The assertions read the command and scope back OUT of
 * the constructed snapshot and compare the emitted row to that source, proving
 * the resolution *carries the stack value through* rather than re-stating a
 * literal — the `doc_lint_command_stays_stack_sourced` contract: the command
 * originates in stack data, never a hardcoded ecosystem token in evaluator-core.
 */
describe('web-node docLintInvocations resolution (Q6 Sprint-2)', () => {
  function webNodeStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
    // Faithful to the resolved snapshot's web-node docLintCmd: the command is
    // the stack-declared value the tool backs, with delta baseline + blocker.
    return {
      name: 'web-node',
      scope: ['**/*.ts', '**/*.tsx'],
      docLintCmd: {
        command: 'npm run doc-lint',
        absenceSignal: 'warning',
        absenceMessage:
          'The framework could not run the documentation linter for this stack. Confirm a `doc-lint` script is configured for the project and re-run, or review the changed exports by hand before merging.\n',
        severity: 'blocker',
        baseline: 'delta',
      },
    };
  }

  it('buildDocLintInvocations resolves web-node to its stack-declared command and fields', () => {
    const stack = webNodeStack();
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [stack],
      mergedSplicePoints: {},
    };

    const rows = buildDocLintInvocations(snapshot);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.stack).toBe('web-node');
    // Command is whatever the stack declared — read from the source, proving the
    // resolution carries it through rather than re-stating a literal here.
    expect(row!.command).toBe(stack.docLintCmd!.command);
    // The fields the evaluator needs to run and grade it, resolved from the stack.
    expect(row!.severity).toBe('blocker');
    expect(row!.baseline).toBe('delta');
    expect(row!.absenceSignal).toBe('warning');
    // Scope equals web-node's globs, and is a COPY (a later mutation of the row
    // must not bleed back into the snapshot's array).
    expect(row!.scope).toEqual(stack.scope);
    expect(row!.scope).not.toBe(stack.scope);
  });

  it('the same row flows unchanged through buildEvaluatorPlan into plan.docLintInvocations', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };

    const plan = buildEvaluatorPlan(snapshot, NO_SPRINT, NO_WORKTREE);

    // The plan field equals the direct builder output — the assembly step does
    // not alter the resolved row on its way into the plan.
    expect(plan.docLintInvocations).toEqual(buildDocLintInvocations(snapshot));
    expect(plan.docLintInvocations).toHaveLength(1);
    const [row] = plan.docLintInvocations;
    // Read the resolved command back from the plan and compare to the stack
    // source — the end-to-end /gan resolution the spec names as a criterion.
    expect(row!.command).toBe(snapshot.activeStacks[0]!.docLintCmd!.command);
    expect(row!.stack).toBe('web-node');
    expect(row!.severity).toBe('blocker');
    expect(row!.baseline).toBe('delta');
    expect(row!.absenceSignal).toBe('warning');
    expect(row!.scope).toEqual(['**/*.ts', '**/*.tsx']);
  });
});

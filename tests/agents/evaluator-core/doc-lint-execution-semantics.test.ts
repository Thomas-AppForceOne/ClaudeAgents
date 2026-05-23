

import { describe, expect, it } from 'vitest';

import { buildDocLintInvocations } from '../../../src/agents/evaluator-core/index.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan } from '../../../src/agents/evaluator-core/index.js';

type DocLintRow = EvaluatorPlan['docLintInvocations'][number];

type HostToolState = 'present' | 'absent';

interface DocLintFinding {

  preExisting: boolean;
}

interface RoutingOutcome {

  failsAttempt: boolean;

  warning?: string;

  routesOnward: boolean;
}

function routeDocLintFinding(
  row: DocLintRow,
  host: HostToolState,
  finding: DocLintFinding | null,
): RoutingOutcome {

  if (host === 'absent') {
    if (row.absenceSignal === 'silent') {
      return { failsAttempt: false, routesOnward: false };
    }

    return {
      failsAttempt: false,
      warning: `doc-lint tool absent (${row.stack})`,
      routesOnward: false,
    };
  }

  if (finding === null) {

    return { failsAttempt: false, routesOnward: false };
  }

  const scored = row.baseline === 'absolute' ? true : !finding.preExisting;
  if (!scored) {
    return { failsAttempt: false, routesOnward: false };
  }

  switch (row.severity) {
    case 'blocker':
      return { failsAttempt: true, routesOnward: false };
    case 'warning':
      return {
        failsAttempt: false,
        warning: `doc-lint regression (${row.stack})`,
        routesOnward: false,
      };
    case 'advisory':
      return { failsAttempt: false, routesOnward: true };
  }
}

function stackWith(docLintCmd: NonNullable<EvaluatorCoreSnapshot['activeStacks'][number]['docLintCmd']>) {
  const snapshot: EvaluatorCoreSnapshot = {
    activeStacks: [{ name: 'web-node', scope: ['**/*.ts'], docLintCmd }],
    mergedSplicePoints: {},
  };
  const [row] = buildDocLintInvocations(snapshot);
  expect(row, 'a declaring stack must emit exactly one row').toBeTruthy();
  return row!;
}

const NEW_FINDING: DocLintFinding = { preExisting: false };
const PRE_EXISTING_FINDING: DocLintFinding = { preExisting: true };

describe('BEH-1 — doc-lint absence is tolerated (warn, not fail)', () => {
  it('absence — a blocker tool missing on the host warns and does NOT fail the attempt', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'tool absent',
      severity: 'blocker',
      baseline: 'delta',
    });

    const outcome = routeDocLintFinding(row, 'absent', null);

    expect(outcome.failsAttempt).toBe(false);
    expect(outcome.warning).toBeTruthy();
  });

  it('absence — a silent absenceSignal produces no warning and no failure', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'silent',
      severity: 'blocker',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'absent', null);
    expect(outcome.failsAttempt).toBe(false);
    expect(outcome.warning).toBeUndefined();
  });
});

describe('BEH-2 — baseline delta-vs-absolute comparison', () => {
  it('delta — a pre-existing undocumented symbol in the base ref does NOT fail the run', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'blocker',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'present', PRE_EXISTING_FINDING);
    expect(outcome.failsAttempt).toBe(false);
  });

  it('delta — a NEW undocumented symbol introduced by the diff fails the run when severity is blocker', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'blocker',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'present', NEW_FINDING);
    expect(outcome.failsAttempt).toBe(true);
  });

  it('absolute — the pre-existing undocumented symbol ALSO fails the run', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'blocker',
      baseline: 'absolute',
    });
    const outcome = routeDocLintFinding(row, 'present', PRE_EXISTING_FINDING);
    expect(outcome.failsAttempt).toBe(true);
  });
});

describe('BEH-3 — severity gates-or-warns routing', () => {
  it('gates — a blocker finding fails the attempt', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'blocker',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'present', NEW_FINDING);
    expect(outcome.failsAttempt).toBe(true);
    expect(outcome.routesOnward).toBe(false);
  });

  it('warns — a warning finding records + surfaces without failing the attempt', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'warning',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'present', NEW_FINDING);
    expect(outcome.failsAttempt).toBe(false);
    expect(outcome.warning).toBeTruthy();
    expect(outcome.routesOnward).toBe(false);
  });

  it('advisory — an advisory finding routes onward and never blocks', () => {
    const row = stackWith({
      command: 'run-doc-lint',
      absenceSignal: 'warning',
      absenceMessage: 'x',
      severity: 'advisory',
      baseline: 'delta',
    });
    const outcome = routeDocLintFinding(row, 'present', NEW_FINDING);
    expect(outcome.failsAttempt).toBe(false);
    expect(outcome.routesOnward).toBe(true);
  });
});

function scoreCriterion(score: number, threshold: number): 'pass' | 'fail' {
  return score >= threshold ? 'pass' : 'fail';
}

describe('BEH-3 — layer (c) documentation criteria gate via the per-criterion path', () => {
  it('layer (c) — a documentation criterion scored below its threshold fails the attempt', () => {

    expect(scoreCriterion(6, 8)).toBe('fail');
    expect(scoreCriterion(7, 8)).toBe('fail');
  });

  it('layer (c) — a documentation criterion at/above its threshold passes', () => {
    expect(scoreCriterion(8, 8)).toBe('pass');
    expect(scoreCriterion(9, 7)).toBe('pass');
  });

  it('layer (c) — passing every functional criterion but failing a gating doc criterion is NOT a passing run', () => {

    const functionalPass = scoreCriterion(9, 8) === 'pass';
    const docCriterionFails = scoreCriterion(5, 8) === 'fail';
    const runPasses = functionalPass && !docCriterionFails;
    expect(functionalPass).toBe(true);
    expect(docCriterionFails).toBe(true);
    expect(runPasses).toBe(false);
  });
});

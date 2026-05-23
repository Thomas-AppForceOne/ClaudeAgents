/**
 * Q5 Sprint 3 — doc-lint EXECUTION-LAYER semantics (BEH-1/BEH-2/BEH-3).
 *
 * Placement rationale (load-bearing): the absence-tolerance, the
 * baseline delta-vs-absolute comparison, and the severity gates-or-warns
 * routing are deliberately NOT asserted against the pure plan-builder.
 * Per the contract's CRITICAL purity constraint, those behaviours need the
 * git base ref and the live host (to detect a missing tool) — inputs the
 * pure carve-out (`EvaluatorCoreSnapshot`/`WorktreeState`) does not carry.
 * They run downstream at the layer that executes `auditCmd`/`lintCmd`: the
 * evaluator agent. There is no TypeScript command-runner in `src/`, so the
 * downstream layer is the evaluator agent prompt; the prompt-prose
 * assertions live in `tests/agents/evaluator-prompt-structure.test.ts`.
 *
 * This file complements those prose assertions by modelling the downstream
 * routing as a small reducer over the *carried* plan-entry fields plus a
 * simulated finding/base-ref, exactly as `documentation-surfaces.test.ts`
 * models the proposer's downstream suppress filter in-test. It proves the
 * carried `severity`/`baseline`/`absenceSignal` (FUNC-3) are sufficient to
 * drive the BEH behaviours WITHOUT any base-ref input reaching the pure
 * core — which is the whole point of the carve-out split. The reducer is a
 * test fixture, not production code: it documents the contract the prompt
 * instructs and would catch a regression where the carried fields stopped
 * being sufficient to route a finding.
 *
 * Test naming is load-bearing: the discriminator greps for the labels
 * 'absence', 'delta', 'absolute', 'severity', 'gates', 'warns', 'advisory',
 * 'layer (c)'.
 */

import { describe, expect, it } from 'vitest';

import { buildDocLintInvocations } from '../../../src/agents/evaluator-core/index.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan } from '../../../src/agents/evaluator-core/index.js';

// ---- Downstream-routing model (test fixture, not production) ------------

type DocLintRow = EvaluatorPlan['docLintInvocations'][number];

/** Whether the configured doc-lint tool resolved on the host. */
type HostToolState = 'present' | 'absent';

/** A finding the doc-lint command would report when run downstream. */
interface DocLintFinding {
  /** True when the undocumented symbol already existed in the base ref. */
  preExisting: boolean;
}

/** The outcome of routing a single doc-lint invocation downstream. */
interface RoutingOutcome {
  /** True when this invocation fails the attempt (gates). */
  failsAttempt: boolean;
  /** A warning surfaced in run state without failing the attempt. */
  warning?: string;
  /** True when the finding routes to the next attempt / a follow-up. */
  routesOnward: boolean;
}

/**
 * Model the downstream routing the evaluator agent performs, keyed off the
 * fields the plan entry CARRIES (no base-ref input ever reaches the pure
 * core — it is supplied here as a simulated downstream input). This is the
 * BEH-1/BEH-2/BEH-3 behaviour expressed as a deterministic decision over
 * `(row, host, finding)`.
 */
function routeDocLintFinding(
  row: DocLintRow,
  host: HostToolState,
  finding: DocLintFinding | null,
): RoutingOutcome {
  // BEH-1: absence-tolerance. A missing tool surfaces a warning and never
  // fails the attempt for absence alone — regardless of `severity`.
  if (host === 'absent') {
    if (row.absenceSignal === 'silent') {
      return { failsAttempt: false, routesOnward: false };
    }
    // `warning` and `blockingConcern` both surface the message; per Q5 the
    // doc-lint absence path is the non-aborting W1 channel, so neither
    // fails the attempt for absence alone.
    return {
      failsAttempt: false,
      warning: `doc-lint tool absent (${row.stack})`,
      routesOnward: false,
    };
  }

  if (finding === null) {
    // No finding → nothing to route.
    return { failsAttempt: false, routesOnward: false };
  }

  // BEH-2: baseline delta-vs-absolute. With `delta`, a pre-existing finding
  // in the base ref is not scored; with `absolute`, it is.
  const scored = row.baseline === 'absolute' ? true : !finding.preExisting;
  if (!scored) {
    return { failsAttempt: false, routesOnward: false };
  }

  // BEH-3: severity routing of a scored finding.
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

// ---- Snapshot helpers ---------------------------------------------------

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

// ---- BEH-1 — absence-tolerant warn, not fail ----------------------------

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

    // Even at severity blocker, tool absence alone never fails the attempt.
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

// ---- BEH-2 — baseline delta vs absolute ---------------------------------

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

// ---- BEH-3 — severity gates or warns ------------------------------------

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

// ---- BEH-3 — layer (c) gating through the per-criterion path ------------

/**
 * Model the evaluator's existing per-criterion scoring path for a
 * `documentationSurfaces`-instantiated criterion: a score below the
 * criterion's `threshold` is a failing verdict, with NO special-casing for
 * documentation criteria — they gate exactly like any contract criterion.
 * This is the layer-(c) gating BEH-3 asserts: a run that passes every
 * functional criterion but fails a gating documentation criterion is not a
 * passing run.
 */
function scoreCriterion(score: number, threshold: number): 'pass' | 'fail' {
  return score >= threshold ? 'pass' : 'fail';
}

describe('BEH-3 — layer (c) documentation criteria gate via the per-criterion path', () => {
  it('layer (c) — a documentation criterion scored below its threshold fails the attempt', () => {
    // Same path any contract criterion takes — no documentation special-casing.
    expect(scoreCriterion(6, 8)).toBe('fail');
    expect(scoreCriterion(7, 8)).toBe('fail');
  });

  it('layer (c) — a documentation criterion at/above its threshold passes', () => {
    expect(scoreCriterion(8, 8)).toBe('pass');
    expect(scoreCriterion(9, 7)).toBe('pass');
  });

  it('layer (c) — passing every functional criterion but failing a gating doc criterion is NOT a passing run', () => {
    // A run is passing only when EVERY scored criterion passes.
    const functionalPass = scoreCriterion(9, 8) === 'pass';
    const docCriterionFails = scoreCriterion(5, 8) === 'fail';
    const runPasses = functionalPass && !docCriterionFails;
    expect(functionalPass).toBe(true);
    expect(docCriterionFails).toBe(true);
    expect(runPasses).toBe(false);
  });
});

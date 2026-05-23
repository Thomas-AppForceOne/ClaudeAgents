/**
 * A1 sprint-wide attempt-budget suite — proves the aggregate-ceiling halt is a
 * pure decision over the same reconstructed per-role tally the per-role check
 * consumes, composing with (but independent of) `checkRoleCeiling`.
 *
 * At-budget halt (summed total >= 12) and below-budget no-halt; the cross-role
 * case where every role is below its per-role ceiling yet the sum hits the budget
 * (the per-role check stays silent while the budget check halts); single-attempt
 * roles (clarifier, planner) counting toward the total without ever tripping a
 * per-role ceiling; the sprintBudgetExceeded evidence shape (accept A1's worked
 * example, reject mis-shaped) with totalAttempts == sum(perRoleCounts); the
 * prototype-pollution guard on the summation; and the LoopDetected error +
 * buildLoopDetectedBody reuse for the new discriminator.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTEMPT_CEILINGS,
  checkRoleCeiling,
} from '../../src/safety/loop-detection.js';
import {
  DEFAULT_SPRINT_BUDGET,
  SPRINT_ROLE,
  checkSprintBudget,
  buildSprintBudgetEvidence,
  isSprintBudgetEvidence,
  renderSprintBudgetMessage,
  createSprintBudgetError,
  type SprintBudgetEvidence,
} from '../../src/safety/sprint-budget.js';
import { buildLoopDetectedBody } from '../../src/trace/integration.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';
import type { RoleAttemptState } from '../../src/trace/reconcile.js';

const RUN_ID = '20260521T194720-6752';

// Build a per-role tally in the shape reconstructRecoveryState produces
// (Record<role, RoleAttemptState>) from a plain role->count map, so a test reads
// as a tally without restating the RoleAttemptState shape at every call site.
function tally(counts: Record<string, number>): Record<string, RoleAttemptState> {
  const out: Record<string, RoleAttemptState> = {};
  for (const [role, count] of Object.entries(counts)) {
    out[role] = { attemptCount: count, highestAttemptNumber: count };
  }
  return out;
}

// A1's worked example tally (A1 § Examples): the per-role counts that sum to 12.
const WORKED_EXAMPLE = {
  'gan-clarifier': 1,
  'gan-planner': 1,
  'gan-contract-proposer': 3,
  'gan-generator': 3,
  'gan-contract-reviewer': 2,
  'gan-evaluator': 2,
};

describe('default_sprint_budget_is_the_seed_value_12', () => {
  it('defaults to 12', () => {
    expect(DEFAULT_SPRINT_BUDGET).toBe(12);
  });
});

describe('sprint_budget_check_halts_when_combined_total_reaches_budget', () => {
  it('halts when the summed total reaches the budget (>= 12)', () => {
    const decision = checkSprintBudget({ attemptStateByRole: tally(WORKED_EXAMPLE) });

    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('sprintBudgetExceeded');
    expect(decision.fields?.role).toBe('sprint');
    expect(decision.fields?.attempts).toBe(12);
    expect(decision.fields?.ceiling).toBe(12);
  });

  it('does not halt when the summed total stays below the budget', () => {
    const decision = checkSprintBudget({
      attemptStateByRole: tally({ 'gan-contract-proposer': 3, 'gan-generator': 3 }),
    });
    expect(decision.halt).toBe(false);
    expect(decision.fields).toBeUndefined();
  });

  it('halts when the total exceeds the budget (strictly greater)', () => {
    const decision = checkSprintBudget({
      attemptStateByRole: tally({ ...WORKED_EXAMPLE, 'gan-generator': 4 }),
    });
    expect(decision.halt).toBe(true);
    expect(decision.fields?.attempts).toBe(13);
  });

  it('honours a caller-supplied budget (an overlay-style override)', () => {
    // At 6 combined attempts: halts under a budget of 6, not under the default 12.
    const six = tally({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    expect(checkSprintBudget({ attemptStateByRole: six, budget: 6 }).halt).toBe(true);
    expect(checkSprintBudget({ attemptStateByRole: six }).halt).toBe(false);
  });

  it('does not halt an empty tally', () => {
    expect(checkSprintBudget({ attemptStateByRole: {} }).halt).toBe(false);
  });
});

describe('budget_sums_all_roles_below_each_per_role_ceiling', () => {
  it('halts on the aggregate while every per-role ceiling stays silent', () => {
    // No single role is at or above its per-role ceiling of 3 (proposer 2,
    // generator 2), yet the combined total reaches the budget of 12 once the
    // other roles' attempts are added.
    const crossRole = tally({
      'gan-clarifier': 1,
      'gan-planner': 1,
      'gan-contract-proposer': 2,
      'gan-generator': 2,
      'gan-contract-reviewer': 3,
      'gan-evaluator': 3,
    });

    // The sprint-wide budget catches the cross-role thrash...
    const budgetDecision = checkSprintBudget({ attemptStateByRole: crossRole });
    expect(budgetDecision.halt).toBe(true);
    expect(budgetDecision.fields?.attempts).toBe(12);
    expect(budgetDecision.fields?.reason).toBe('sprintBudgetExceeded');

    // ...while the per-role ceiling check halts for none of the individual roles.
    for (const role of Object.keys(crossRole)) {
      const roleDecision = checkRoleCeiling({ role, attemptState: crossRole[role] });
      expect(roleDecision.halt, `per-role ceiling must not fire for ${role}`).toBe(false);
    }
  });

  it('the two ceiling-bearing roles really are below their ceiling in this tally', () => {
    // Guards the premise: proposer/generator at 2 are genuinely under their
    // table ceiling of 3, so the cross-role assertion above is meaningful.
    expect(DEFAULT_ATTEMPT_CEILINGS['gan-contract-proposer']).toBe(3);
    expect(DEFAULT_ATTEMPT_CEILINGS['gan-generator']).toBe(3);
  });
});

describe('single_attempt_roles_count_toward_budget_but_never_ceiling', () => {
  it('includes clarifier and planner attempts in the budget total', () => {
    const withSingles = tally({
      'gan-clarifier': 1,
      'gan-planner': 1,
      'gan-contract-proposer': 3,
      'gan-generator': 3,
      'gan-contract-reviewer': 2,
      'gan-evaluator': 2,
    });
    const evidence = buildSprintBudgetEvidence(withSingles);

    // Both single-attempt roles appear in the count map and contribute to the sum.
    expect(evidence.perRoleCounts['gan-clarifier']).toBe(1);
    expect(evidence.perRoleCounts['gan-planner']).toBe(1);
    expect(evidence.totalAttempts).toBe(12);

    // Dropping the two single-attempt roles would put the sprint under budget,
    // proving they are not excluded from the summation.
    const withoutSingles = tally({
      'gan-contract-proposer': 3,
      'gan-generator': 3,
      'gan-contract-reviewer': 2,
      'gan-evaluator': 2,
    });
    expect(buildSprintBudgetEvidence(withoutSingles).totalAttempts).toBe(10);
    expect(checkSprintBudget({ attemptStateByRole: withoutSingles }).halt).toBe(false);
  });

  it('clarifier and planner never trip a per-role ceiling (absent from the table)', () => {
    for (const role of ['gan-clarifier', 'gan-planner']) {
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_ATTEMPT_CEILINGS, role)).toBe(false);
      const decision = checkRoleCeiling({
        role,
        attemptState: { attemptCount: 5, highestAttemptNumber: 5 },
      });
      expect(decision.halt, `${role} must never trip a per-role ceiling`).toBe(false);
    }
  });
});

describe('sprint_budget_evidence_matches_declared_shape_and_worked_example', () => {
  it('produces evidence matching A1’s worked example', () => {
    const decision = checkSprintBudget({ attemptStateByRole: tally(WORKED_EXAMPLE) });
    const evidence = decision.fields?.evidence as unknown as SprintBudgetEvidence;

    expect(decision.fields?.role).toBe('sprint');
    expect(decision.fields?.attempts).toBe(12);
    expect(decision.fields?.ceiling).toBe(12);
    expect(evidence.totalAttempts).toBe(12);
    expect({ ...evidence.perRoleCounts }).toEqual(WORKED_EXAMPLE);
  });

  it('totalAttempts equals the sum of perRoleCounts values', () => {
    const evidence = buildSprintBudgetEvidence(tally(WORKED_EXAMPLE));
    const sum = Object.values(evidence.perRoleCounts).reduce((a, b) => a + b, 0);
    expect(evidence.totalAttempts).toBe(sum);
  });

  it('accepts a well-formed sprintBudgetExceeded evidence value', () => {
    expect(
      isSprintBudgetEvidence({ totalAttempts: 12, perRoleCounts: { ...WORKED_EXAMPLE } }),
    ).toBe(true);
    // The produced value validates against its own declared shape.
    expect(isSprintBudgetEvidence(buildSprintBudgetEvidence(tally(WORKED_EXAMPLE)))).toBe(true);
  });

  it('rejects mis-shaped values', () => {
    // perRoleCounts missing entirely.
    expect(isSprintBudgetEvidence({ totalAttempts: 12 })).toBe(false);
    // a non-integer count.
    expect(
      isSprintBudgetEvidence({ totalAttempts: 12, perRoleCounts: { 'gan-generator': 1.5 } }),
    ).toBe(false);
    // a non-integer total.
    expect(
      isSprintBudgetEvidence({ totalAttempts: 12.5, perRoleCounts: { 'gan-generator': 1 } }),
    ).toBe(false);
    // perRoleCounts not an object.
    expect(isSprintBudgetEvidence({ totalAttempts: 1, perRoleCounts: 7 })).toBe(false);
    // not an object / array / null.
    expect(isSprintBudgetEvidence(null)).toBe(false);
    expect(isSprintBudgetEvidence([])).toBe(false);
    expect(isSprintBudgetEvidence('nope')).toBe(false);
  });
});

describe('sprint_budget_halt_reuses_loop_detected_error_and_body_builder', () => {
  const decision = checkSprintBudget({ attemptStateByRole: tally(WORKED_EXAMPLE) });
  const fields = decision.fields!;

  it('constructs a LoopDetected error with the sprintBudgetExceeded discriminator', () => {
    const error = createSprintBudgetError(
      fields,
      `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`,
    );

    // Same error code as the per-role halt — one LoopDetected code, no parallel.
    expect(error.code).toBe('LoopDetected');
    expect(error.reason).toBe('sprintBudgetExceeded');
    expect(error.role).toBe('sprint');
    expect(error.attempts).toBe(12);
    expect(error.ceiling).toBe(12);

    const json = error.toJSON();
    expect(json.code).toBe('LoopDetected');
    for (const field of ['reason', 'role', 'attempts', 'ceiling', 'evidence']) {
      expect(Object.prototype.hasOwnProperty.call(json, field)).toBe(true);
    }
  });

  it('feeds buildLoopDetectedBody to produce a schema-valid safetyHalt body', () => {
    const body = buildLoopDetectedBody({
      reason: fields.reason,
      role: fields.role,
      attempts: fields.attempts,
      ceiling: fields.ceiling,
      evidence: fields.evidence,
    });

    expect(body.safetyClass).toBe('loopDetected');
    expect(body.role).toBe('sprint');
    expect(body.payload.reason).toBe('sprintBudgetExceeded');
    expect(body.payload.attempts).toBe(12);
    expect(body.payload.ceiling).toBe(12);

    // Wrapped in an envelope it validates against the run-trace schema (T1 owns
    // the safetyHalt class; A1 supplies the loopDetected discriminator value).
    const validate = getRunTraceValidator();
    const event = {
      sequenceNumber: 12,
      eventType: 'safetyHalt',
      timestamp: '2026-05-21T19:47:20.000Z',
      runId: RUN_ID,
      ...body,
    };
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('sprint_role_is_distinct_from_per_role_ceiling_roles', () => {
  it('the sentinel role constant is exactly "sprint"', () => {
    expect(SPRINT_ROLE).toBe('sprint');
  });

  it('"sprint" carries no entry in the per-role ceiling table', () => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_ATTEMPT_CEILINGS, 'sprint')).toBe(false);
  });

  it('checkRoleCeiling never fires for the "sprint" sentinel role', () => {
    const decision = checkRoleCeiling({
      role: 'sprint',
      attemptState: { attemptCount: 99, highestAttemptNumber: 99 },
    });
    expect(decision.halt).toBe(false);
  });

  it('the budget halt’s role field is exactly the string "sprint"', () => {
    const decision = checkSprintBudget({ attemptStateByRole: tally(WORKED_EXAMPLE) });
    expect(decision.fields?.role).toBe('sprint');
  });
});

describe('budget_summation_guards_against_prototype_pollution', () => {
  it('a __proto__-named role neither pollutes Object.prototype nor crashes', () => {
    // A synthetic tally with the pollution vector as a role. Built on a
    // null-prototype object so the hostile key is a real own key the summation
    // must defensively skip rather than fold into the total or set on the proto.
    const hostile: Record<string, RoleAttemptState> = Object.create(null) as Record<
      string,
      RoleAttemptState
    >;
    Object.defineProperty(hostile, '__proto__', {
      value: { attemptCount: 999, highestAttemptNumber: 999 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    hostile['gan-generator'] = { attemptCount: 2, highestAttemptNumber: 2 };

    const evidence = buildSprintBudgetEvidence(hostile);

    // The forbidden key is dropped from the map and the sum: only the real role
    // contributes, so the 999 cannot silently corrupt the total.
    expect(evidence.totalAttempts).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(evidence.perRoleCounts, '__proto__')).toBe(false);
    expect(evidence.perRoleCounts['gan-generator']).toBe(2);

    // Nothing leaked onto the prototype, and the check did not crash.
    expect((Object.prototype as Record<string, unknown>).attemptCount).toBeUndefined();
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);

    // The full check over the hostile tally also stays sane.
    expect(checkSprintBudget({ attemptStateByRole: hostile }).halt).toBe(false);
  });

  it('constructor- and prototype-named roles are also skipped from the sum', () => {
    const hostile: Record<string, RoleAttemptState> = Object.create(null) as Record<
      string,
      RoleAttemptState
    >;
    for (const key of ['constructor', 'prototype']) {
      Object.defineProperty(hostile, key, {
        value: { attemptCount: 50, highestAttemptNumber: 50 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    hostile['gan-generator'] = { attemptCount: 1, highestAttemptNumber: 1 };

    const evidence = buildSprintBudgetEvidence(hostile);
    expect(evidence.totalAttempts).toBe(1);
    expect(Object.keys(evidence.perRoleCounts)).toEqual(['gan-generator']);
  });
});

describe('sprint_budget_halt_message_follows_user_facing_error_discipline', () => {
  const traceDir = `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`;
  const message = renderSprintBudgetMessage({ attempts: 12, ceiling: 12 }, traceDir);

  it('points at the trace directory and mentions --recover', () => {
    expect(message).toContain(traceDir);
    expect(message).toContain('--recover');
  });

  it('refers to the framework / ClaudeAgents', () => {
    expect(/\b(the framework|ClaudeAgents)\b/.test(message)).toBe(true);
  });

  it('contains no forbidden ecosystem or maintainer-script tokens', () => {
    const forbidden = [
      'npm',
      'node',
      'vitest',
      'pnpm',
      'yarn',
      'package.json',
      'tsconfig',
      'lint-no-stack-leak',
      'lint-error-text',
    ];
    const lower = message.toLowerCase();
    for (const token of forbidden) {
      expect(lower.includes(token.toLowerCase()), `message must not contain '${token}'`).toBe(
        false,
      );
    }
  });
});

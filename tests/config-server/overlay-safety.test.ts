// Schema-conformance tests for the overlay-v1 `safety.*` block added in A1
// (sprint 5): safety.attemptCeilings (per-role positive-integer map),
// safety.sprintBudget (positive integer), and safety.oscillationDetection
// (boolean). Two things are guarded:
//   1. Each new field accepts its valid shapes — the bare value, the cascade
//      wrapper { discardInherited, value } that stops inheritance from a lower
//      tier, and a safety-level scalar discardInherited — and REJECTS mis-typed
//      values: a negative or zero ceiling, a non-integer or zero/negative
//      sprintBudget, and a non-boolean oscillationDetection. The schema is
//      closed (additionalProperties off), so an unknown sibling is rejected too.
//   2. The three fields are OPTIONAL/additive: an overlay omitting all of them
//      (including the empty {} body) validates clean, proving the closed schema
//      did not invalidate previously-valid documents.
//
// Each reject case is asserted SEPARATELY (per the contract's "a schema that
// forgot the positive-integer or boolean constraint cannot pass") so a missing
// constraint surfaces as a distinct failing test, not a hidden gap. As in the
// telemetry suite, the error message must not leak the underlying validator's
// name ("ajv") — error text is a product UX contract. FILE only labels issues.
import { describe, expect, it } from 'vitest';

import {
  validateOverlayBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const FILE = '/tmp/overlay-safety.test/project.md';

// Wraps the validator: every body is given a valid schemaVersion so each test
// supplies only the safety fragment under test.
function validate(body: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(FILE, { schemaVersion: 1, ...body }, issues);
  return issues;
}

describe('overlay-v1: safety.* well-typed accept (A1)', () => {
  it('accepts the three fields together, well-typed', () => {
    expect(
      validate({
        safety: {
          attemptCeilings: { 'gan-generator': 5 },
          sprintBudget: 20,
          oscillationDetection: false,
        },
      }),
    ).toEqual([]);
  });

  it('accepts safety.attemptCeilings as a per-role map of positive integers', () => {
    expect(
      validate({ safety: { attemptCeilings: { 'gan-generator': 5, 'gan-contract-proposer': 2 } } }),
    ).toEqual([]);
  });

  it('accepts safety.sprintBudget as a positive integer', () => {
    expect(validate({ safety: { sprintBudget: 12 } })).toEqual([]);
  });

  it('accepts safety.oscillationDetection: true and false', () => {
    expect(validate({ safety: { oscillationDetection: true } })).toEqual([]);
    expect(validate({ safety: { oscillationDetection: false } })).toEqual([]);
  });

  it('accepts the cascade wrapper { discardInherited, value } on each field', () => {
    expect(
      validate({ safety: { attemptCeilings: { discardInherited: true, value: { 'gan-generator': 4 } } } }),
    ).toEqual([]);
    expect(
      validate({ safety: { sprintBudget: { discardInherited: true, value: 9 } } }),
    ).toEqual([]);
    expect(
      validate({ safety: { oscillationDetection: { discardInherited: false, value: false } } }),
    ).toEqual([]);
  });

  it('accepts a safety-level discardInherited (scalar cascade, both tiers)', () => {
    expect(validate({ safety: { discardInherited: true } })).toEqual([]);
  });
});

describe('overlay-v1: safety.* mis-typed reject (A1)', () => {
  it('rejects a negative attemptCeilings value', () => {
    const issues = validate({ safety: { attemptCeilings: { 'gan-generator': -1 } } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
    for (const i of issues) expect(i.message.toLowerCase()).not.toContain('ajv');
  });

  it('rejects a zero attemptCeilings value', () => {
    const issues = validate({ safety: { attemptCeilings: { 'gan-generator': 0 } } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects a non-integer attemptCeilings value', () => {
    const issues = validate({ safety: { attemptCeilings: { 'gan-generator': 2.5 } } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects a non-integer sprintBudget', () => {
    const issues = validate({ safety: { sprintBudget: 3.5 } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects a zero / negative sprintBudget', () => {
    expect(validate({ safety: { sprintBudget: 0 } }).length).toBeGreaterThan(0);
    expect(validate({ safety: { sprintBudget: -5 } }).length).toBeGreaterThan(0);
  });

  it('rejects a non-boolean oscillationDetection', () => {
    const issues = validate({ safety: { oscillationDetection: 'yes' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects an unknown property under safety', () => {
    expect(validate({ safety: { notAField: 1 } }).length).toBeGreaterThan(0);
  });
});

describe('overlay-v1: safety.* is optional/additive (A1)', () => {
  it('accepts an overlay omitting all three safety fields', () => {
    expect(validate({ runner: { thresholdOverride: 7 } })).toEqual([]);
  });

  it('accepts an empty overlay body (no safety block at all)', () => {
    expect(validate({})).toEqual([]);
  });
});

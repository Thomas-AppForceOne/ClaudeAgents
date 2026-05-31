// Schema-conformance tests for the additive overlay-v1 `safety.renegotiationCap`
// field. The field is the per-sprint maximum number of contract-renegotiation
// rounds (a positive integer) — distinct from the attempt-ceilings/sprint-budget
// machinery already present, so the schema layer must validate it as a separate
// well-typed positive-integer field. Three things are guarded:
//
//  1. Valid shapes are accepted: a bare positive integer AND the cascade
//     wrapper `{ discardInherited, value }` (matching every other safety
//     field's two-form pattern).
//  2. Mis-typed values are REJECTED, each as a separate assertion so a
//     missing constraint surfaces as a specific failing test rather than a
//     hidden gap: zero, negative, a string, a non-integer float.
//  3. The closed `safety` block still rejects unknown siblings AND every
//     pre-existing safety field (attemptCeilings, sprintBudget,
//     oscillationDetection) keeps validating alongside the new field — i.e.
//     adding renegotiationCap did not regress the closed-object discipline
//     or break existing fixtures.
//
// Mirrors the structural pattern of `tests/config-server/overlay-safety.test.ts`
// so a reader who knows that file can follow this one too. Error messages must
// not leak the underlying validator's name ("ajv") — error text is a product
// UX contract — but this is already covered by overlay-safety.test.ts for the
// validator path; here we just rely on the same validator entrypoint.

import { describe, expect, it } from 'vitest';

import {
  validateOverlayBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const FILE = '/tmp/overlay-renegotiation-cap.test/project.md';

// Wrap the validator: every body gets a valid `schemaVersion: 1` so each test
// only supplies the safety fragment under test.
function validate(body: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(FILE, { schemaVersion: 1, ...body }, issues);
  return issues;
}

describe('overlay_v1_accepts_renegotiation_cap — well-typed accept', () => {
  it('accepts safety.renegotiationCap: 3 as a positive integer (the bare form)', () => {
    expect(validate({ safety: { renegotiationCap: 3 } })).toEqual([]);
  });

  it('accepts safety.renegotiationCap: 1 (the minimum)', () => {
    // The schema's minimum is 1 — a per-sprint cap of zero rounds would
    // mean renegotiation is disabled; that mode is reached by omitting the
    // overlay key, not by setting it to zero.
    expect(validate({ safety: { renegotiationCap: 1 } })).toEqual([]);
  });

  it('accepts the cascade wrapper { discardInherited, value } on renegotiationCap', () => {
    // Mirrors the cascade-wrapper acceptance every other safety field
    // carries; without this branch, a user could not stop inheritance from
    // a lower tier (project overriding user) for this dimension.
    expect(
      validate({
        safety: { renegotiationCap: { discardInherited: true, value: 4 } },
      }),
    ).toEqual([]);
    expect(
      validate({
        safety: { renegotiationCap: { discardInherited: false, value: 2 } },
      }),
    ).toEqual([]);
  });

  it('accepts safety.renegotiationCap alongside every pre-existing safety field', () => {
    // The whole-block acceptance: renegotiationCap is additive and must
    // not have changed any existing field's accept conditions.
    expect(
      validate({
        safety: {
          attemptCeilings: { 'gan-generator': 5 },
          sprintBudget: 20,
          oscillationDetection: false,
          renegotiationCap: 3,
        },
      }),
    ).toEqual([]);
  });
});

describe('overlay_v1_accepts_renegotiation_cap — mis-typed reject', () => {
  it('rejects safety.renegotiationCap: 0 (below minimum)', () => {
    const issues = validate({ safety: { renegotiationCap: 0 } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects safety.renegotiationCap: -1 (negative)', () => {
    const issues = validate({ safety: { renegotiationCap: -1 } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects safety.renegotiationCap: "two" (a string)', () => {
    const issues = validate({ safety: { renegotiationCap: 'two' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects safety.renegotiationCap: 2.5 (non-integer)', () => {
    const issues = validate({ safety: { renegotiationCap: 2.5 } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });
});

describe('overlay_v1_accepts_renegotiation_cap — closed safety block preserved', () => {
  it('still rejects an unknown sibling under safety even when renegotiationCap is valid', () => {
    // additionalProperties:false on the safety block must remain intact —
    // adding renegotiationCap did not relax the closed-object discipline.
    const issues = validate({
      safety: { renegotiationCap: 2, unknownKey: 1 },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('continues to validate an overlay that uses only the pre-existing safety fields (no regression)', () => {
    // A fixture exercising only the pre-existing safety fields must still
    // pass — the additive change cannot invalidate previously-valid
    // documents. The three pre-existing fields are checked in one body
    // each plus a combined body, mirroring overlay-safety.test.ts.
    expect(validate({ safety: { attemptCeilings: { 'gan-generator': 5 } } })).toEqual([]);
    expect(validate({ safety: { sprintBudget: 12 } })).toEqual([]);
    expect(validate({ safety: { oscillationDetection: false } })).toEqual([]);
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

  it('accepts an overlay omitting renegotiationCap (the field is optional/additive)', () => {
    // An overlay that sets no safety fields at all, an overlay that sets
    // every safety field EXCEPT renegotiationCap, and an empty overlay all
    // remain valid — the additive change defaults the cap to the schema's
    // declared default of 2.
    expect(validate({ runner: { thresholdOverride: 7 } })).toEqual([]);
    expect(validate({})).toEqual([]);
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
});

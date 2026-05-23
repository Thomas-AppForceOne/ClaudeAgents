// Schema-conformance tests for the overlay-v1 `telemetry.tracePayloads` field
// added in F1.5. Two things are being guarded:
//  1. The new field accepts each of its valid shapes — the bare enum values
//     ("full" / "hashed"), the cascade-wrapper form { discardInherited, value }
//     used to stop inheritance from a lower tier, and a telemetry-level scalar
//     discardInherited — and rejects out-of-enum values and unknown sibling
//     properties (the schema is closed: additionalProperties is off).
//  2. A regression block proving the new field did NOT break the pre-existing
//     splice points (generator.additionalRules, proposer.additionalContext,
//     runner.thresholdOverride) or the empty-overlay case — adding a property
//     to a closed schema is exactly the kind of change that can silently
//     invalidate previously-valid documents.
//
// One assertion is subtle: an out-of-enum value must produce a SchemaMismatch
// whose message does NOT leak the word "ajv" — error text is part of the
// product's UX contract and must read as a domain message, not a raw validator
// dump. FILE is a throwaway path used only to label the issues.
import { describe, expect, it } from 'vitest';

import {
  validateOverlayBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const FILE = '/tmp/overlay-telemetry.test/project.md';

// Wraps the validator: every body is given a valid schemaVersion so each test
// can supply only the telemetry/splice fragment under test.
function validate(body: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  validateOverlayBodyAgainstSchema(FILE, { schemaVersion: 1, ...body }, issues);
  return issues;
}

describe('overlay-v1: telemetry.tracePayloads (F1.5)', () => {
  it('accepts telemetry.tracePayloads: "full"', () => {
    expect(validate({ telemetry: { tracePayloads: 'full' } })).toEqual([]);
  });

  it('accepts telemetry.tracePayloads: "hashed"', () => {
    expect(validate({ telemetry: { tracePayloads: 'hashed' } })).toEqual([]);
  });

  it('accepts the cascade wrapper form { discardInherited, value }', () => {
    expect(
      validate({ telemetry: { tracePayloads: { discardInherited: true, value: 'hashed' } } }),
    ).toEqual([]);
  });

  it('accepts a telemetry-level discardInherited (scalar cascade, both tiers)', () => {
    expect(validate({ telemetry: { discardInherited: true } })).toEqual([]);
  });

  it('rejects an out-of-enum value ("plaintext")', () => {
    // "plaintext" is intentionally NOT an allowed payload mode (no raw payloads).
    const issues = validate({ telemetry: { tracePayloads: 'plaintext' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);

    // The message must be a clean domain error — it must not leak the underlying
    // validator's name. This is a UX contract, not an implementation detail.
    for (const i of issues) {
      expect(i.message.toLowerCase()).not.toContain('ajv');
    }
  });

  it('rejects an unknown property under telemetry', () => {
    const issues = validate({ telemetry: { notAField: 1 } });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('overlay-v1: regression — existing splice points still validate', () => {
  it('accepts generator.additionalRules (bare form)', () => {
    expect(validate({ generator: { additionalRules: ['always pin dependencies'] } })).toEqual([]);
  });

  it('accepts proposer.additionalContext (wrapped form)', () => {
    expect(
      validate({ proposer: { additionalContext: { discardInherited: false, value: ['ctx.md'] } } }),
    ).toEqual([]);
  });

  it('accepts runner.thresholdOverride', () => {
    expect(validate({ runner: { thresholdOverride: 7 } })).toEqual([]);
  });

  it('accepts an empty overlay body', () => {
    expect(validate({})).toEqual([]);
  });
});

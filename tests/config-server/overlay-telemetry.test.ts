/**
 * T1 Sprint 1 — F1.5: the `telemetry.tracePayloads` overlay addition.
 *
 * Exercises the new splice point through the SAME overlay validator the
 * `validateAll` pipeline uses (`validateOverlayBodyAgainstSchema` in
 * `validation/schema-check.ts`). The validator strips C3 frontmatter and
 * enforces the F3 `schemaVersion: 1` exact-match rule before applying the
 * body schema, so each body below carries `schemaVersion: 1`.
 *
 * Assertions:
 *   - an overlay setting telemetry.tracePayloads:"full" validates;
 *   - an overlay setting "hashed" validates;
 *   - the cascade wrapper form ({discardInherited, value}) validates,
 *     matching the file's existing scalar splice-point shape;
 *   - an out-of-enum value ("plaintext") is rejected;
 *   - existing overlay shapes still validate (regression guard for the
 *     one-field additive edit).
 */
import { describe, expect, it } from 'vitest';

import {
  validateOverlayBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const FILE = '/tmp/overlay-telemetry.test/project.md';

/** Run the overlay validator and return the issues it raised. */
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
    const issues = validate({ telemetry: { tracePayloads: 'plaintext' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
    // F4 user-facing-text discipline: messages name the file, not "ajv".
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

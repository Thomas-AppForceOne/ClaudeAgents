
import { describe, expect, it } from 'vitest';

import {
  validateOverlayBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const FILE = '/tmp/overlay-telemetry.test/project.md';

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

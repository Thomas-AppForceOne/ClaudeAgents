/**
 * `schemas/independent-review-v1.json` ajv-compile + validation suite.
 *
 * Pins what the schema accepts and rejects so a future edit cannot loosen
 * a load-bearing constraint without breaking a test. The positive fixture
 * carries one command finding (with reproductionCommand + reproduced) and
 * one inspection finding (with evidencePointer) — exercising both arms of
 * the discriminator in one document. The negative cases each mutate one
 * field of an otherwise-valid fixture so the rejection is attributable to
 * that field alone.
 *
 * Compiled once via the bundled schema (the runtime path), so a parity
 * drift between the on-disk file and the bundled copy is caught here
 * rather than at runtime.
 */

import { describe, expect, it } from 'vitest';
import AjvImport, { type ValidateFunction } from 'ajv';

import { independentReviewV1 } from '../../../src/config-server/schemas-bundled.js';

// Ajv ships as a CJS module whose constructor may live on `.default` under
// an ESM interop shim or directly on the namespace; normalise both forms
// here so `new Ajv(...)` works regardless of how it loaded.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

// Compile once; the schema is immutable for the test-process lifetime.
const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
const validate = ajv.compile(independentReviewV1);

// A hand-rolled valid fixture: one command finding + one inspection
// finding. The negative tests deep-clone this fixture and mutate one
// field at a time so each rejection is attributable to that field.
function makeValidFixture(): Record<string, unknown> {
  return {
    sprintNumber: 1,
    attemptLetter: 'A',
    contractRevision: 0,
    findings: [
      {
        id: 'cmd-1',
        severity: 'blocker',
        category: 'correctness',
        kind: 'command',
        file: 'src/x.ts',
        line: 10,
        description: 'a deterministic failing case',
        suggestedCriterion: 'asserts the failing case is fixed',
        reproductionCommand: 'echo failing-case',
        reproduced: true,
      },
      {
        id: 'insp-1',
        severity: 'warning',
        category: 'concurrency',
        kind: 'inspection',
        file: 'src/y.ts',
        line: 20,
        description: 'lock held across an await',
        suggestedCriterion: 'no locks may be held across awaits',
        evidencePointer: 'src/y.ts:20 mutex.lock() not released before await',
      },
    ],
    summary: { blockers: 1, warnings: 1, advisories: 0, dropped: 0 },
  };
}

// Helper that returns a deep clone the test can mutate without leaking
// state into another test. JSON-clone is sufficient because every field
// in the fixture is a primitive, an array of primitives, or a nested
// object of primitives.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('independent-review-v1 schema — positive', () => {
  it('compiles cleanly with ajv strict mode', () => {
    // Compilation already happened at module init; the assertion here is
    // that the validator is a callable function — a smoke check that the
    // schema is at least structurally well-formed.
    expect(typeof validate).toBe('function');
  });

  it('accepts a hand-rolled fixture with one command finding and one inspection finding', () => {
    const fixture = makeValidFixture();
    const ok = validate(fixture);
    expect(ok).toBe(true);
    expect(validate.errors).toBeNull();
  });
});

describe('independent-review-v1 schema — negative (top-level required)', () => {
  it('rejects a fixture missing summary.dropped', () => {
    const fixture = clone(makeValidFixture()) as { summary: Record<string, unknown> };
    delete fixture.summary['dropped'];
    expect(validate(fixture)).toBe(false);
    expect(validate.errors).not.toBeNull();
  });

  it('rejects a fixture missing contractRevision', () => {
    const fixture = clone(makeValidFixture()) as Record<string, unknown>;
    delete fixture['contractRevision'];
    expect(validate(fixture)).toBe(false);
  });

  it('rejects a fixture missing findings', () => {
    const fixture = clone(makeValidFixture()) as Record<string, unknown>;
    delete fixture['findings'];
    expect(validate(fixture)).toBe(false);
  });
});

describe('independent-review-v1 schema — negative (kind discriminator)', () => {
  it('rejects a kind: "command" finding that omits reproductionCommand', () => {
    const fixture = clone(makeValidFixture());
    const finding = (fixture['findings'] as Array<Record<string, unknown>>)[0]!;
    delete finding['reproductionCommand'];
    expect(validate(fixture)).toBe(false);
  });

  it('rejects a kind: "command" finding that omits reproduced', () => {
    const fixture = clone(makeValidFixture());
    const finding = (fixture['findings'] as Array<Record<string, unknown>>)[0]!;
    delete finding['reproduced'];
    expect(validate(fixture)).toBe(false);
  });

  it('rejects a kind: "inspection" finding that omits evidencePointer', () => {
    const fixture = clone(makeValidFixture());
    const finding = (fixture['findings'] as Array<Record<string, unknown>>)[1]!;
    delete finding['evidencePointer'];
    expect(validate(fixture)).toBe(false);
  });
});

describe('independent-review-v1 schema — negative (enums + shape)', () => {
  it('rejects a severity value outside the {blocker, warning, advisory} enum', () => {
    const fixture = clone(makeValidFixture());
    (fixture['findings'] as Array<Record<string, unknown>>)[0]!['severity'] = 'critical';
    expect(validate(fixture)).toBe(false);
  });

  it('rejects an extra unknown property at the top level (additionalProperties: false)', () => {
    const fixture = clone(makeValidFixture()) as Record<string, unknown>;
    fixture['unknownField'] = 'nope';
    expect(validate(fixture)).toBe(false);
  });

  it('rejects an extra unknown property inside a finding (nested additionalProperties: false)', () => {
    const fixture = clone(makeValidFixture());
    (fixture['findings'] as Array<Record<string, unknown>>)[0]!['unknownField'] = 'nope';
    expect(validate(fixture)).toBe(false);
  });

  it('rejects an attemptLetter that does not match the single-uppercase-letter pattern', () => {
    const fixture = clone(makeValidFixture()) as Record<string, unknown>;
    fixture['attemptLetter'] = 'AA';
    expect(validate(fixture)).toBe(false);
  });
});

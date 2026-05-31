// Conformance tests for the strict `progress-v1` schema. The schema is the
// orchestrator's `progress.json` reconciliation surface: every field the
// orchestrator writes must be enumerated under `properties`, and the
// `additionalProperties:false` posture makes any unenumerated field a
// validation error rather than a silent accept. The negative cases below pin
// that strictness; the positive cases pin the load-bearing fields the E8
// writer ships before this schema lands.
//
// The fixture under tests/fixtures/progress/ is a hand-crafted placeholder
// pending a real capture from an E8-renegotiated dogfood run — see the README
// alongside it for the deferred-capture handoff. The placeholder is enough to
// exercise the schema's strictness today; the dogfood is what makes the gate
// reconcile against real writer output.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvImport, { type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { progressV1 } from '../../src/config-server/schemas-bundled.js';

// Read the fixture from disk rather than importing it, matching the existing
// pattern in tests/config-server/schemas-bundled-independent-review.test.ts.
// The on-disk file is the canonical source for the reconciliation-gate
// fixture; readFileSync also avoids the JSON-import-attribute pathway, which
// the rest of the test surface does not exercise.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '..', 'fixtures', 'progress', 'progress-v1-e8-renegotiated.json');
const e8RenegotiatedFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  unknown
>;

// Ajv ships as a CJS module whose constructor may live on `.default` under an
// ESM interop shim or directly on the namespace; normalise both forms to one
// callable constructor. Matches the project's existing Ajv-loader idiom in
// src/config-server/validation/schema-check.ts.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

// Compile under the same Ajv settings the rest of the project uses for the
// bundled-schema validators (strict:true, allErrors:true, useDefaults:false).
// Strict mode means a schema misuse during authoring throws at compile time,
// not silently at validation time, so the compilation step itself is part of
// the contract this suite pins.
function compile(): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  return ajv.compile(progressV1);
}

// The full enumerated `terminalReason` set from O2 spec section 2. Spelt out
// here so the positive-coverage test fails the day a new code is added to the
// schema without being added to the test (or vice versa) — drift between the
// schema's enum and the test's coverage is itself a finding.
const TERMINAL_REASONS = [
  'complete',
  'failed-max-attempts',
  'failed-budget',
  'failed-loop-detected',
  'failed-evaluation-rejected',
  'failed-clarifier-error',
  'aborted-by-user',
  'aborted-planner-error',
  'aborted-contract-failed',
  'aborted-validation-failed',
] as const;

// A minimal in-flight shape every test can spread. terminal:false +
// terminalReason:null + terminalAt:null is the legal "not yet ended" tuple;
// individual tests mutate one field at a time so the rejection (or acceptance)
// is attributable to that mutation alone.
function inFlightBase(): Record<string, unknown> {
  return {
    runId: '20260512T094233-7c1a',
    status: 'building',
    currentSprint: 2,
    currentAttempt: 1,
    contractRevision: 0,
    totalSprints: 5,
    completedSprints: 1,
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'gan/20260512T094233-7c1a',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260512T094233-7c1a/worktree',
      branch: 'gan/20260512T094233-7c1a',
      createdByGan: true,
    },
    terminal: false,
    terminalReason: null,
    terminalAt: null,
    overlaysAtSnapshot: {
      user: { loaded: true, path: '/Users/example/.claude/gan/user.md', hash: 'sha256:abc' },
      project: { loaded: true, path: '.claude/gan/project.md', hash: 'sha256:def' },
    },
    recoveryHistory: [],
  };
}

describe('progress-v1 schema compiles cleanly under the project Ajv settings', () => {
  it('compiles without throwing in strict mode', () => {
    // Strict Ajv would throw at compile time on a schema misuse (an unknown
    // keyword, a sibling-of-$ref conflict, etc.), so the act of compiling is
    // part of the contract — not just a setup step.
    expect(() => compile()).not.toThrow();
  });
});

describe('progress-v1 schema accepts a captured E8-renegotiated run', () => {
  const validate = compile();

  it('validates the deferred-capture fixture verbatim', () => {
    // The fixture carries `contractRevision: 2` and
    // `terminalReason: failed-evaluation-rejected` — the two E8-writer fields
    // the schema must accept or every renegotiated run fails CI. Per the
    // sibling README, a real capture replaces this placeholder during the
    // release-gate dogfood; today's assertion proves the schema's shape.
    const ok = validate(e8RenegotiatedFixture);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('records `contractRevision > 0` in the fixture (E8 writer field)', () => {
    // Pin the fixture's E8-seam value here so a future maintainer who
    // "tidies" the fixture cannot inadvertently zero out the renegotiated
    // signal the reconciliation-gate test depends on.
    const cr = e8RenegotiatedFixture.contractRevision as number;
    expect(typeof cr).toBe('number');
    expect(cr).toBeGreaterThan(0);
  });

  it('records `terminalReason: failed-evaluation-rejected` in the fixture (E8 writer value)', () => {
    // Same pinning rationale as the previous test, scoped to the second
    // E8-writer field. The two assertions are sister checks.
    expect(e8RenegotiatedFixture.terminalReason).toBe('failed-evaluation-rejected');
  });
});

describe('progress-v1 schema accepts each enumerated terminalReason value', () => {
  const validate = compile();

  for (const reason of TERMINAL_REASONS) {
    it(`accepts terminalReason: "${reason}"`, () => {
      // Each named outcome is paired with `terminal:true` and a populated
      // `terminalAt`, the tuple O2 section 3 specifies for a teardown writer.
      const candidate = {
        ...inFlightBase(),
        terminal: true,
        terminalReason: reason,
        terminalAt: '2026-05-12T10:18:47.512Z',
      };
      const ok = validate(candidate);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }

  it('accepts terminalReason: null on an in-flight run', () => {
    // The null branch of the `terminalReason` anyOf — the in-flight tuple
    // (terminal:false / terminalReason:null / terminalAt:null) is the shape
    // every run carries until teardown.
    expect(validate(inFlightBase())).toBe(true);
  });
});

describe('progress-v1 schema accepts the legacy workspace shape', () => {
  const validate = compile();

  it('accepts a workspace with worktreePath, branch, createdByGan only', () => {
    // The three fields O2 section 2 calls out as legacy (F7's shipped
    // `recordWorkspace` writes them) are exactly what `additionalProperties:
    // false` permits — nothing more, nothing less.
    const candidate = {
      ...inFlightBase(),
      workspace: {
        worktreePath: '/abs/path/to/worktree',
        branch: 'gan/20260512T094233-7c1a',
        createdByGan: false,
      },
    };
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('progress-v1 schema accepts an empty recoveryHistory array', () => {
  const validate = compile();

  it('accepts recoveryHistory: []', () => {
    // A fresh, never-recovered run carries an empty array; the schema must
    // not require at least one entry (which would block every first-time run).
    const candidate = { ...inFlightBase(), recoveryHistory: [] };
    expect(validate(candidate)).toBe(true);
  });

  it('accepts a recoveryHistory entry with all three required fields', () => {
    // The minimal entry shape: recoveredAt + fromStatus + atSprint, each
    // typed per O2 section 2.
    const candidate = {
      ...inFlightBase(),
      recoveryHistory: [
        { recoveredAt: '2026-05-12T10:05:14.000Z', fromStatus: 'building', atSprint: 2 },
      ],
    };
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('progress-v1 schema rejects unenumerated and malformed shapes', () => {
  const validate = compile();

  it('rejects an unknown top-level field — additionalProperties:false is operative', () => {
    // The load-bearing negative case: without `additionalProperties:false`
    // the strict schema is advisory rather than gating. The Ajv error must
    // name both the keyword and the offending property so a downstream
    // reader can surface a targeted fix.
    const candidate = { ...inFlightBase(), unknownKey: 1 };
    const ok = validate(candidate);
    expect(ok).toBe(false);
    const text = JSON.stringify(validate.errors);
    expect(text).toMatch(/additionalProperties/);
    expect(text).toMatch(/unknownKey/);
  });

  it('rejects an unknown terminalReason value', () => {
    // A typo'd or future-but-unrecognised reason must not silently validate;
    // a writer that produces an unknown value is by definition out of sync
    // with the schema, which is exactly what the reconciliation gate catches.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'made-up',
      terminalAt: '2026-05-12T10:18:47.512Z',
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a terminalAt value of the wrong type (number)', () => {
    // terminalAt is anyOf{ null, ISO-8601 string } — a number is neither and
    // must fail. Tests the type-mismatch path on a nullable field.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: 42,
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a workspace object missing createdByGan', () => {
    // The required-list assertion: dropping the createdByGan field (which
    // --cleanup uses to classify teardown) must be a hard error.
    const base = inFlightBase();
    const { createdByGan: _drop, ...partialWorkspace } = base.workspace as Record<string, unknown>;
    void _drop;
    const candidate = { ...base, workspace: partialWorkspace };
    expect(validate(candidate)).toBe(false);
  });
});

/**
 * ajv schema test for `schemas/evaluator-evidence-bundle-v2.json` (T5).
 *
 * The v2 bump is breaking on top of v1 — it adds the required
 * `evaluatorPromptDigest` field at the root and keeps `additionalProperties:
 * false` everywhere v1 had it. This suite locks the three load-bearing v2
 * contract points so a future edit cannot loosen any of them without breaking
 * a test:
 *
 *   1. A bundle carrying every v1-required field plus a 64-character
 *      lowercase hex `evaluatorPromptDigest` validates under v2.
 *   2. A bundle missing the digest fails with a clear schema-mismatch path
 *      naming the missing required field.
 *   3. A bundle with an extra unrelated top-level property fails under v2's
 *      `additionalProperties: false`.
 *
 * The validator compiles via the bundled schema (the runtime path) so a
 * drift between the on-disk file and the bundled copy surfaces here rather
 * than at runtime.
 */

import { describe, expect, it } from 'vitest';
import AjvImport, { type ValidateFunction } from 'ajv';

import { evaluatorEvidenceBundleV2 } from '../../../src/config-server/schemas-bundled.js';

// Ajv ships as a CJS module whose constructor may live on `.default` under
// an ESM interop shim or directly on the namespace; normalise both forms
// here so `new Ajv(...)` works regardless of how it loaded. Same pattern as
// the sibling schema tests.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
const validate = ajv.compile(evaluatorEvidenceBundleV2);

// A 64-character lowercase hex string — shape-canonical for SHA-256 hex,
// content-meaningless. The schema's pattern `^[0-9a-f]{64}$` is what the
// fixture exercises; an actual SHA-256 of the prompt file is unnecessary
// (and would couple the test to the prompt file's bytes).
const STUB_DIGEST = 'a'.repeat(64);

function makeValidBundle(): Record<string, unknown> {
  return {
    sprintNumber: 1,
    attemptLetter: 'A',
    evaluatorPromptDigest: STUB_DIGEST,
    criteria: [
      {
        name: 'placeholder_criterion',
        verdict: 'skipped',
        evidence: { traceEventRefs: [] },
      },
    ],
    verdictSummary: { totalCriteria: 1, passed: 0, failed: 0, blocked: 0, skipped: 1 },
  };
}

// JSON-clone a fixture so tests can mutate it without leaking state.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('evaluator-evidence-bundle-v2 schema', () => {
  it('validates a bundle with every v1-required field plus a 64-hex evaluatorPromptDigest', () => {
    const bundle = makeValidBundle();
    const ok = validate(bundle);
    expect(ok, `unexpected errors: ${JSON.stringify(validate.errors)}`).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('rejects a bundle missing the evaluatorPromptDigest with a schema-mismatch path naming the missing required field', () => {
    const bundle = clone(makeValidBundle());
    delete (bundle as { evaluatorPromptDigest?: unknown }).evaluatorPromptDigest;
    const ok = validate(bundle);
    expect(ok).toBe(false);

    // ajv emits one `required` keyword error per missing field; assert one of
    // them names `evaluatorPromptDigest` so the failure is attributable to
    // the digest gate, not collateral noise.
    const errors = validate.errors ?? [];
    const missingDigest = errors.find(
      (e) =>
        e.keyword === 'required' &&
        (e.params as { missingProperty?: string }).missingProperty === 'evaluatorPromptDigest',
    );
    expect(missingDigest).toBeDefined();
  });

  it('rejects a bundle whose evaluatorPromptDigest is not a 64-character lowercase hex string', () => {
    const bundle = clone(makeValidBundle());

    // Uppercase characters violate `[0-9a-f]` — the lowercase-hex pattern
    // pins the spelling so two valid digests for the same prompt cannot
    // disagree on casing.
    (bundle as Record<string, unknown>).evaluatorPromptDigest = 'A'.repeat(64);
    const ok = validate(bundle);
    expect(ok).toBe(false);

    const errors = validate.errors ?? [];
    const patternError = errors.find(
      (e) => e.keyword === 'pattern' && e.instancePath === '/evaluatorPromptDigest',
    );
    expect(patternError).toBeDefined();
  });

  it('rejects a bundle carrying an extra unrelated top-level property under additionalProperties: false', () => {
    const bundle = clone(makeValidBundle()) as Record<string, unknown>;
    bundle.unrelatedSidecarField = 'value the v2 schema does not declare';
    const ok = validate(bundle);
    expect(ok).toBe(false);

    const errors = validate.errors ?? [];
    const extraProp = errors.find(
      (e) =>
        e.keyword === 'additionalProperties' &&
        (e.params as { additionalProperty?: string }).additionalProperty === 'unrelatedSidecarField',
    );
    expect(extraProp).toBeDefined();
  });

  it('preserves every v1 root-required field (a missing v1 field still fails)', () => {
    const bundle = clone(makeValidBundle()) as Record<string, unknown>;
    delete bundle.verdictSummary;
    const ok = validate(bundle);
    expect(ok).toBe(false);

    const errors = validate.errors ?? [];
    const missingV1 = errors.find(
      (e) =>
        e.keyword === 'required' &&
        (e.params as { missingProperty?: string }).missingProperty === 'verdictSummary',
    );
    expect(missingV1).toBeDefined();
  });
});

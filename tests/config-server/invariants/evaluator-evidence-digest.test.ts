/**
 * Coverage for the consumer-side digest invariant (T5).
 *
 * `assertEvaluatorEvidenceDigest` is the second gate the bundle reader runs
 * after the schema validator — it pins the digest contract at consumption
 * time so a legacy v1-shaped bundle reaching the consumer through a code path
 * that skipped the schema check is still rejected. The tests cover one
 * happy-path case and two failure-mode cases the contract explicitly names:
 * the missing-digest case (a v1-shaped bundle) and the malformed-digest case
 * (the digest field is present but is not a SHA-256 hex string).
 */

import { describe, expect, it } from 'vitest';

import { assertEvaluatorEvidenceDigest } from '../../../src/config-server/invariants/evaluator-evidence-digest.js';

// 64-character lowercase hex stand-in for a SHA-256 of the evaluator-prompt.
// Shape-canonical (matches the pattern the schema enforces); not a real hash
// — the invariant only inspects the shape, not the bytes the orchestrator
// would have hashed.
const STUB_DIGEST = 'a'.repeat(64);

describe('assertEvaluatorEvidenceDigest — happy path', () => {
  it('accepts a bundle carrying a 64-character lowercase hex evaluatorPromptDigest', () => {
    const result = assertEvaluatorEvidenceDigest({
      sprintNumber: 1,
      attemptLetter: 'A',
      evaluatorPromptDigest: STUB_DIGEST,
      criteria: [],
      verdictSummary: { totalCriteria: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBeUndefined();
  });
});

describe('assertEvaluatorEvidenceDigest — missing-digest path', () => {
  it('rejects a v1-shaped bundle that lacks the evaluatorPromptDigest field', () => {
    const result = assertEvaluatorEvidenceDigest({
      sprintNumber: 1,
      attemptLetter: 'A',
      criteria: [],
      verdictSummary: { totalCriteria: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MissingDigest');

    // The user-visible message names the field so a developer reading a
    // structured-error surface can connect the failure to the orchestrator
    // step that should have stamped the digest.
    expect(result.message).toContain('evaluatorPromptDigest');
  });
});

describe('assertEvaluatorEvidenceDigest — malformed-digest path', () => {
  it('rejects a digest that is not a string', () => {
    const result = assertEvaluatorEvidenceDigest({
      evaluatorPromptDigest: 12345,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MalformedDigest');
  });

  it('rejects a digest with the wrong length (63 hex chars)', () => {
    const result = assertEvaluatorEvidenceDigest({
      evaluatorPromptDigest: 'a'.repeat(63),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MalformedDigest');
  });

  it('rejects a digest carrying uppercase hex (the schema pins lowercase)', () => {
    const result = assertEvaluatorEvidenceDigest({
      evaluatorPromptDigest: 'A'.repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MalformedDigest');
  });

  it('rejects a digest carrying non-hex characters', () => {
    const result = assertEvaluatorEvidenceDigest({
      evaluatorPromptDigest: 'g'.repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MalformedDigest');
  });
});

describe('assertEvaluatorEvidenceDigest — input-shape guard', () => {
  it('rejects a null input with BundleNotObject', () => {
    const result = assertEvaluatorEvidenceDigest(null);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BundleNotObject');
  });

  it('rejects an array input with BundleNotObject', () => {
    const result = assertEvaluatorEvidenceDigest([]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BundleNotObject');
  });

  it('rejects a primitive input with BundleNotObject', () => {
    const result = assertEvaluatorEvidenceDigest('not a bundle');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BundleNotObject');
  });
});

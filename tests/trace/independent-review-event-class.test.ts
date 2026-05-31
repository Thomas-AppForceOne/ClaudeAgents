/**
 * Schema-level acceptance tests for the new `independentReview` event class
 * in `schemas/run-trace-v1.json`.
 *
 * What this guards:
 * - A well-formed `independentReview` event passes the shipped run-trace
 *   validator (positive path).
 * - An event missing any single required payload field is rejected — one
 *   negative test per required field, so a future schema edit that loosens
 *   a field's `required` listing fails this test attributable to the field
 *   that was dropped.
 * - The shipped event classes that pre-dated this sprint (agentAttempt,
 *   llmCall, safetyHalt, …) still validate — the additive change must not
 *   regress an existing class's acceptance.
 *
 * The suite uses the shipped validator (`getRunTraceValidator`) rather than
 * compiling ajv against the raw schema file, so the test exercises the same
 * code path the runtime uses.
 */

import { describe, expect, it } from 'vitest';

import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';

const ENVELOPE = {
  sequenceNumber: 9,
  timestamp: '2026-05-30T23:00:00.000Z',
  runId: '20260530T230000-ireview',
} as const;

const VALID_PAYLOAD = {
  sprintNumber: 2,
  attemptLetter: 'A',
  contractRevision: 0,
  verdict: 'findings' as const,
  summary: {
    blockers: 1,
    warnings: 0,
    advisories: 2,
    dropped: 1,
  },
};

const VALID_EVENT = {
  ...ENVELOPE,
  eventType: 'independentReview',
  payload: VALID_PAYLOAD,
} as const;

describe('independentReview — accepted shapes', () => {
  it('validates a well-formed independentReview event', () => {
    const validate = getRunTraceValidator();
    const ok = validate(VALID_EVENT);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts verdict === 'clean' with all-zero counts", () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: {
        ...VALID_PAYLOAD,
        verdict: 'clean' as const,
        summary: { blockers: 0, warnings: 0, advisories: 0, dropped: 0 },
      },
    };
    expect(validate(event)).toBe(true);
  });

  it('accepts contractRevision: 3 (a re-locked revision)', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, contractRevision: 3 },
    };
    expect(validate(event)).toBe(true);
  });
});

describe('independentReview — rejected shapes (one negative per required payload field)', () => {
  // One iteration per required payload field so a failure points at which
  // field's required listing the test caught — keeps the table-driven
  // assertion attributable when a future schema change loosens one field.
  const REQUIRED_PAYLOAD_FIELDS = [
    'sprintNumber',
    'attemptLetter',
    'contractRevision',
    'verdict',
    'summary',
  ] as const;

  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    it(`rejects an event whose payload is missing the required field '${field}'`, () => {
      const validate = getRunTraceValidator();
      const payload: Record<string, unknown> = { ...VALID_PAYLOAD };
      delete payload[field];
      const event = { ...VALID_EVENT, payload };
      expect(validate(event)).toBe(false);
    });
  }

  const REQUIRED_SUMMARY_FIELDS = ['blockers', 'warnings', 'advisories', 'dropped'] as const;

  for (const field of REQUIRED_SUMMARY_FIELDS) {
    it(`rejects an event whose payload.summary is missing the required field '${field}'`, () => {
      const validate = getRunTraceValidator();
      const summary: Record<string, unknown> = { ...VALID_PAYLOAD.summary };
      delete summary[field];
      const event = {
        ...VALID_EVENT,
        payload: { ...VALID_PAYLOAD, summary },
      };
      expect(validate(event)).toBe(false);
    });
  }

  it("rejects an unknown verdict value (verdict must be 'clean' | 'findings')", () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, verdict: 'maybe' },
    };
    expect(validate(event)).toBe(false);
  });

  it('rejects a lowercase attemptLetter (pattern is uppercase single ASCII letter)', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, attemptLetter: 'a' },
    };
    expect(validate(event)).toBe(false);
  });

  it('rejects a multi-character attemptLetter ("AA")', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, attemptLetter: 'AA' },
    };
    expect(validate(event)).toBe(false);
  });

  it('rejects a negative contractRevision (-1)', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, contractRevision: -1 },
    };
    expect(validate(event)).toBe(false);
  });

  it('rejects sprintNumber: 0 (sprints are 1-indexed)', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: { ...VALID_PAYLOAD, sprintNumber: 0 },
    };
    expect(validate(event)).toBe(false);
  });

  it('rejects a negative summary counter (blockers: -1)', () => {
    const validate = getRunTraceValidator();
    const event = {
      ...VALID_EVENT,
      payload: {
        ...VALID_PAYLOAD,
        summary: { ...VALID_PAYLOAD.summary, blockers: -1 },
      },
    };
    expect(validate(event)).toBe(false);
  });
});

describe('independentReview — pre-existing event classes still validate (regression carry-forward)', () => {
  // A handful of fabricated fixtures from pre-existing event classes — the
  // additive new event class must not regress an existing class's acceptance.
  // Re-running these here rather than depending on the broader schema-test
  // suite makes the regression guard self-contained in this file.
  const validate = getRunTraceValidator();

  it('still validates an agentAttempt event', () => {
    expect(
      validate({
        ...ENVELOPE,
        eventType: 'agentAttempt',
        role: 'gan-generator',
        attemptNumber: 1,
        inputDigest: 'a'.repeat(64),
        outputArtifactPath: 'sprint-1-output.json',
        disposition: 'completed',
      }),
    ).toBe(true);
  });

  it('still validates an llmCall event', () => {
    expect(
      validate({
        ...ENVELOPE,
        eventType: 'llmCall',
        model: 'claude-opus-4',
        role: 'gan-generator',
        promptRef: 'b'.repeat(64),
        responseRef: 'c'.repeat(64),
        tokensInput: 100,
        tokensCached: 0,
        tokensOutput: 50,
        latencyMs: 200,
        cacheHit: false,
      }),
    ).toBe(true);
  });

  it('still validates a safetyHalt event', () => {
    expect(
      validate({
        ...ENVELOPE,
        eventType: 'safetyHalt',
        safetyClass: 'loopDetected',
        role: 'gan-orchestrator',
        payload: { reason: 'noProgress' },
      }),
    ).toBe(true);
  });
});

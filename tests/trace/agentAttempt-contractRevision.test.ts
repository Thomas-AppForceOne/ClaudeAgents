/**
 * Schema-level acceptance tests for the additive `contractRevision` field on
 * `agentAttempt` events.
 *
 * The field is optional and additive — a trace produced before it existed
 * still validates, a producer that does stamp it is constrained to a
 * non-negative integer, and a malformed value (negative integer, string)
 * is rejected. The suite exercises each branch directly against the
 * shipped run-trace validator, no orchestrator in the loop.
 */

import { describe, expect, it } from 'vitest';

import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';

const ENVELOPE = {
  sequenceNumber: 1,
  timestamp: '2026-05-30T23:00:00.000Z',
  runId: '20260530T230000-rev1',
} as const;

const BASE_AGENT_ATTEMPT = {
  ...ENVELOPE,
  eventType: 'agentAttempt',
  role: 'gan-generator',
  attemptNumber: 1,
  inputDigest: 'a'.repeat(64),
  outputArtifactPath: 'attempt.json',
  disposition: 'completed',
} as const;

describe('agentAttempt.contractRevision — accepted values', () => {
  it('accepts contractRevision: 0 (the original locked contract)', () => {
    const validate = getRunTraceValidator();
    expect(validate({ ...BASE_AGENT_ATTEMPT, contractRevision: 0 })).toBe(true);
  });

  it('accepts contractRevision: 2 (a re-locked contract revision)', () => {
    const validate = getRunTraceValidator();
    expect(validate({ ...BASE_AGENT_ATTEMPT, contractRevision: 2 })).toBe(true);
  });

  it('accepts an agentAttempt event WITHOUT the field (additive optional)', () => {
    const validate = getRunTraceValidator();
    // No contractRevision key at all — the field is optional and absent
    // means "the original locked contract" by convention. A pre-sprint
    // trace produced before the field existed must still validate.
    expect(validate({ ...BASE_AGENT_ATTEMPT })).toBe(true);
  });
});

describe('agentAttempt.contractRevision — rejected values', () => {
  it('rejects a negative integer (-1)', () => {
    const validate = getRunTraceValidator();
    expect(validate({ ...BASE_AGENT_ATTEMPT, contractRevision: -1 })).toBe(false);
  });

  it('rejects a non-integer (string "two")', () => {
    const validate = getRunTraceValidator();
    expect(validate({ ...BASE_AGENT_ATTEMPT, contractRevision: 'two' })).toBe(false);
  });

  it('rejects a non-integer number (1.5)', () => {
    const validate = getRunTraceValidator();
    expect(validate({ ...BASE_AGENT_ATTEMPT, contractRevision: 1.5 })).toBe(false);
  });
});

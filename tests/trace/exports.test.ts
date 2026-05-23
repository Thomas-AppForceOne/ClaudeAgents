
import { describe, expect, it } from 'vitest';

import * as traceBarrel from '../../src/trace/index.js';
import * as topBarrel from '../../src/index.js';

const NEW_HELPERS = [

  'verifyEvidenceBundle',
  'checkFailCompleteness',

  'buildTrustEventBody',
  'buildValidationAbortBody',
  'buildValidationAbortFromCode',

  'formatHeartbeat',
  'formatLlmCallSummary',
  'formatSprintSummary',
  'aggregateSprintSummary',
  'formatSprintSummaryFromEvents',
  'formatWallclock',

  'reconstructRecoveryState',
  'nextRecoverySequence',
] as const;

describe('new_helpers_exported_and_build_green', () => {
  it('every new Sprint-3 helper is reachable from the trace barrel as a function', () => {
    for (const name of NEW_HELPERS) {
      expect(typeof (traceBarrel as Record<string, unknown>)[name], `trace barrel: ${name}`).toBe(
        'function',
      );
    }
  });

  it('every new Sprint-3 helper is re-exported from the top-level public barrel', () => {
    for (const name of NEW_HELPERS) {
      expect(typeof (topBarrel as Record<string, unknown>)[name], `top barrel: ${name}`).toBe(
        'function',
      );
    }
  });

  it('the Sprint-2 surface is still reachable (no regression in the barrel)', () => {
    for (const name of [
      'TraceEmitter',
      'scanEvents',
      'reconcileIndex',
      'isUnrecoverable',
      'safeMergeParsedObject',
      'computePromptRef',
    ]) {
      expect(typeof (topBarrel as Record<string, unknown>)[name], `top barrel: ${name}`).toBe(
        'function',
      );
    }
  });
});

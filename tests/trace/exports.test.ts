/**
 * T1 Sprint 3 — public barrel exports (new_helpers_exported_and_build_green).
 *
 * The new Sprint-3 helpers must be reachable from both the trace barrel
 * (src/trace/index.ts) and the top-level public barrel (src/index.ts) so
 * downstream phases import them rather than re-deriving them — mirroring the
 * Sprint-2 export pattern. `npm run build` is the compile gate; this test is
 * the reachability gate.
 */
import { describe, expect, it } from 'vitest';

import * as traceBarrel from '../../src/trace/index.js';
import * as topBarrel from '../../src/index.js';

const NEW_HELPERS = [
  // evidence-bundle verifier (F3.2)
  'verifyEvidenceBundle',
  'checkFailCompleteness',
  // integration-event builders (F3.3, F3.4)
  'buildTrustEventBody',
  'buildValidationAbortBody',
  'buildValidationAbortFromCode',
  // progress-line formatters (F3.5, F3.6, F3.7)
  'formatHeartbeat',
  'formatLlmCallSummary',
  'formatSprintSummary',
  'aggregateSprintSummary',
  'formatSprintSummaryFromEvents',
  'formatWallclock',
  // recovery continuation (F3.8)
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

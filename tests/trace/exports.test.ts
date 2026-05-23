/**
 * Public-surface guard for the trace barrels — pins what the Sprint-3 work
 * adds to the package's API and proves it didn't drop the Sprint-2 surface.
 *
 * Why this exists: helpers can be implemented yet never wired into a barrel,
 * leaving them unreachable to consumers and to the rest of the framework. This
 * suite asserts every new Sprint-3 helper is a callable export from BOTH the
 * trace barrel (src/trace/index.js) and the top-level public barrel
 * (src/index.js) — re-export, not just internal definition — and that the
 * pre-existing Sprint-2 surface is still reachable, so a re-export refactor
 * can't silently regress the API. A `typeof === 'function'` check is a
 * deliberately coarse but stable contract: it survives signature changes while
 * still catching a missing or renamed export.
 */

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

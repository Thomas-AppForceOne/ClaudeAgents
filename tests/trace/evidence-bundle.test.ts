/**
 * Evidence-bundle verifier suite — guards the four independent gates that make
 * an evaluator's verdict bundle trustworthy. verifyEvidenceBundle runs all four
 * and reports each failure tagged by `check`, so the tests assert on the
 * specific check rather than just an overall pass/fail.
 *
 * The four checks:
 * - schema: the bundle validates against evaluator-evidence-bundle. An ajv
 *   error (e.g. an out-of-enum verdict, a missing top-level field) must surface
 *   in `schemaErrors` and as a `schema` failure, never be swallowed.
 * - joinKey: every criterion `name` must exist in the sprint contract; an
 *   unknown name fails and the offending name is named in the detail (catches
 *   a typo'd criterion claiming a verdict for nothing in the contract).
 * - refIntegrity: every `traceEventRef` (`<eventType>:<sequence>`) must resolve
 *   to a real event AND its eventType must match the event at that sequence —
 *   so a dangling sequence and a type-mismatched ref both fail. An empty
 *   refs array (a skipped criterion) resolves trivially.
 * - failCompleteness: a `fail` verdict must carry BOTH a reproductionCommand
 *   and a deltaFromContract; an empty reproductionCommand counts as missing.
 *   checkFailCompleteness is unit-tested directly: it names every absent field,
 *   only the absent field, and ignores non-fail verdicts entirely.
 *
 * Fixtures: trace() supplies two resolvable events at seq 42/43; CONTRACT names
 * the two criteria validBundle() references, so the happy path passes all four
 * checks and each negative test perturbs exactly one field.
 */

import { describe, expect, it } from 'vitest';

import { verifyEvidenceBundle, checkFailCompleteness } from '../../src/trace/evidence-bundle.js';
import { getEvaluatorEvidenceBundleValidator } from '../../src/config-server/validation/schema-check.js';
import type { TraceEvent } from '../../src/trace/events.js';

const RUN_ID = '20260521T194720-6752';
const SHA = 'c'.repeat(64);

function trace(): TraceEvent[] {
  return [
    {
      sequenceNumber: 42,
      eventType: 'llmCall',
      timestamp: '2026-05-21T19:47:20.000Z',
      runId: RUN_ID,
      model: 'm',
      role: 'gan-generator',
      promptRef: SHA,
      responseRef: SHA,
      tokensInput: 1,
      tokensCached: 0,
      tokensOutput: 1,
      latencyMs: 1,
      cacheHit: false,
    },
    {
      sequenceNumber: 43,
      eventType: 'toolCall',
      timestamp: '2026-05-21T19:47:21.000Z',
      runId: RUN_ID,
      tool: 'Read',
      role: 'gan-generator',
      argumentsRef: 'payloads/0000000043-gan-generator-arguments.json',
      resultRef: 'payloads/0000000043-gan-generator-result.md',
      disposition: 'completed',
      latencyMs: 1,
    },
  ] as TraceEvent[];
}

const CONTRACT = [{ name: 'tls_required_for_sensitive_traffic' }, { name: 'prototype_pollution' }];

function validBundle(): unknown {
  return {
    sprintNumber: 2,
    attemptLetter: 'A',
    criteria: [
      {
        name: 'tls_required_for_sensitive_traffic',
        verdict: 'pass',
        evidence: {
          traceEventRefs: ['llmCall:42', 'toolCall:43'],
          reproductionCommand: "rg -n 'http://' src/handler.ts",
          deltaFromContract: {
            expected: 'no plaintext HTTP for credentialed traffic',
            observed: 'all credentialed callers use https://',
          },
        },
      },
      {
        name: 'prototype_pollution',
        verdict: 'fail',
        evidence: {
          traceEventRefs: ['toolCall:43'],
          reproductionCommand: 'vitest run tests/trace/reconcile.test.ts',
          deltaFromContract: {
            expected: 'merge rejects __proto__/constructor/prototype',
            observed: 'merge folds __proto__ into reconciled state',
          },
        },
      },
    ],
    verdictSummary: { totalCriteria: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 },
  };
}

describe('evidence_bundle_verifier_validates_against_schema', () => {
  it('reports schema-valid=true for a valid bundle (and the helper passes)', () => {
    const result = verifyEvidenceBundle(validBundle(), CONTRACT, trace());
    expect(result.schemaValid).toBe(true);
    expect(result.schemaErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('rejects a verdict outside the enum and surfaces the ajv error (not swallowed)', () => {
    const bundle = validBundle() as { criteria: { verdict: string }[] };
    bundle.criteria[0]!.verdict = 'almost';
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.schemaValid).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.schemaErrors.length).toBeGreaterThan(0);

    expect(getEvaluatorEvidenceBundleValidator()(bundle)).toBe(false);
    expect(result.failures.some((f) => f.check === 'schema')).toBe(true);
  });

  it('rejects a bundle missing a required top-level field (verdictSummary)', () => {
    const bundle = validBundle() as Record<string, unknown>;
    delete bundle.verdictSummary;
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.schemaValid).toBe(false);
    expect(result.schemaErrors.length).toBeGreaterThan(0);
  });
});

describe('evidence_bundle_join_key_invariant', () => {
  it('accepts a bundle whose every criterion name appears in the contract', () => {
    const result = verifyEvidenceBundle(validBundle(), CONTRACT, trace());
    expect(result.failures.filter((f) => f.check === 'joinKey')).toEqual([]);
  });

  it('rejects a criterion name absent from the contract, naming the offender', () => {
    const bundle = validBundle() as { criteria: { name: string }[] };
    bundle.criteria[1]!.name = 'prototypePollutionTypo';
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(false);
    const joinFails = result.failures.filter((f) => f.check === 'joinKey');
    expect(joinFails).toHaveLength(1);
    expect(joinFails[0]!.criterionName).toBe('prototypePollutionTypo');
    expect(joinFails[0]!.detail).toContain('prototypePollutionTypo');
  });
});

describe('evidence_bundle_ref_integrity', () => {
  it('accepts a bundle whose every traceEventRef resolves', () => {
    const result = verifyEvidenceBundle(validBundle(), CONTRACT, trace());
    expect(result.failures.filter((f) => f.check === 'refIntegrity')).toEqual([]);
  });

  it('rejects a dangling ref — sequence with no event — naming the unresolved ref', () => {
    const bundle = validBundle() as { criteria: { evidence: { traceEventRefs: string[] } }[] };
    bundle.criteria[0]!.evidence.traceEventRefs = ['llmCall:42', 'toolCall:999'];
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(false);
    const refFails = result.failures.filter((f) => f.check === 'refIntegrity');
    expect(refFails).toHaveLength(1);
    expect(refFails[0]!.unresolvedRef).toBe('toolCall:999');
  });

  it('rejects a ref whose eventType does not match the event at that sequence', () => {
    const bundle = validBundle() as { criteria: { evidence: { traceEventRefs: string[] } }[] };

    // Sequence 42 exists but is an llmCall, so claiming `toolCall:42` is a
    // type mismatch — refIntegrity must reject it, not just check existence.
    bundle.criteria[0]!.evidence.traceEventRefs = ['toolCall:42'];
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(false);
    const refFails = result.failures.filter((f) => f.check === 'refIntegrity');
    expect(refFails).toHaveLength(1);
    expect(refFails[0]!.unresolvedRef).toBe('toolCall:42');
  });

  it('treats an empty traceEventRefs array (skipped) as trivially resolving', () => {
    const bundle = {
      sprintNumber: 1,
      attemptLetter: 'A',
      criteria: [
        {
          name: 'tls_required_for_sensitive_traffic',
          verdict: 'skipped',
          evidence: { traceEventRefs: [] },
        },
      ],
      verdictSummary: { totalCriteria: 1, passed: 0, failed: 0, blocked: 0, skipped: 1 },
    };
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(true);
    expect(result.failures.filter((f) => f.check === 'refIntegrity')).toEqual([]);
  });
});

describe('evidence_bundle_fail_carries_repro_and_delta', () => {
  it('accepts a fail criterion carrying both reproductionCommand and deltaFromContract', () => {
    const result = verifyEvidenceBundle(validBundle(), CONTRACT, trace());
    expect(result.failures.filter((f) => f.check === 'failCompleteness')).toEqual([]);
  });

  it('rejects (through the full verifier) a fail criterion missing deltaFromContract', () => {
    const bundle = validBundle() as {
      criteria: { evidence: { deltaFromContract?: unknown } }[];
    };
    delete bundle.criteria[1]!.evidence.deltaFromContract;
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(false);
  });

  it('rejects (through the full verifier) a fail criterion missing reproductionCommand', () => {
    const bundle = validBundle() as {
      criteria: { evidence: { reproductionCommand?: unknown } }[];
    };
    delete bundle.criteria[1]!.evidence.reproductionCommand;
    const result = verifyEvidenceBundle(bundle, CONTRACT, trace());
    expect(result.ok).toBe(false);
  });

  it('checkFailCompleteness names BOTH missing requirements for a bare fail criterion', () => {
    const missing = checkFailCompleteness({
      verdict: 'fail',
      evidence: { traceEventRefs: [] },
    });
    expect(missing.sort()).toEqual(['deltaFromContract', 'reproductionCommand']);
  });

  it('checkFailCompleteness flags only the absent field', () => {
    expect(
      checkFailCompleteness({
        verdict: 'fail',
        evidence: { traceEventRefs: [], reproductionCommand: 'cmd' },
      }),
    ).toEqual(['deltaFromContract']);
    expect(
      checkFailCompleteness({
        verdict: 'fail',
        evidence: {
          traceEventRefs: [],
          deltaFromContract: { expected: 'e', observed: 'o' },
        },
      }),
    ).toEqual(['reproductionCommand']);
  });

  // An empty-string command is present-but-useless; the gate must treat it as
  // missing so a fail can't be "documented" with a blank repro step.
  it('checkFailCompleteness treats an empty reproductionCommand as missing', () => {
    expect(
      checkFailCompleteness({
        verdict: 'fail',
        evidence: {
          traceEventRefs: [],
          reproductionCommand: '',
          deltaFromContract: { expected: 'e', observed: 'o' },
        },
      }),
    ).toEqual(['reproductionCommand']);
  });

  it('checkFailCompleteness treats a complete fail criterion as complete', () => {
    expect(
      checkFailCompleteness({
        verdict: 'fail',
        evidence: {
          traceEventRefs: ['toolCall:43'],
          reproductionCommand: 'cmd',
          deltaFromContract: { expected: 'e', observed: 'o' },
        },
      }),
    ).toEqual([]);
  });

  it('checkFailCompleteness ignores non-fail verdicts (pass/blocked/skipped)', () => {
    for (const verdict of ['pass', 'blocked', 'skipped'] as const) {
      expect(checkFailCompleteness({ verdict, evidence: { traceEventRefs: [] } })).toEqual([]);
    }
  });
});

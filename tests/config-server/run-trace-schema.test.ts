
import { describe, expect, it } from 'vitest';

import {
  getRunTraceValidator,
  getRunTraceIndexValidator,
  getEvaluatorEvidenceBundleValidator,
} from '../../src/config-server/validation/schema-check.js';
import { runTraceV1 } from '../../src/config-server/schemas-bundled.js';

const ENVELOPE = {
  sequenceNumber: 0,
  timestamp: '2026-05-21T19:47:20.123Z',
  runId: '20260521T194720-6752',
} as const;

const VALID_EVENTS: Record<string, Record<string, unknown>> = {
  orchestratorMilestone: {
    ...ENVELOPE,
    eventType: 'orchestratorMilestone',
    milestone: 'sprintEnd',
    disposition: 'success',
    summary: 'Sprint 1 completed.',
  },
  agentAttempt: {
    ...ENVELOPE,
    sequenceNumber: 1,
    eventType: 'agentAttempt',
    role: 'gan-generator',
    attemptNumber: 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: 'sprint-1-output.json',
    disposition: 'completed',
  },
  llmCall: {
    ...ENVELOPE,
    sequenceNumber: 2,
    eventType: 'llmCall',
    model: 'claude-opus-4',
    role: 'gan-generator',
    promptRef: 'b'.repeat(64),
    responseRef: 'c'.repeat(64),
    tokensInput: 1200,
    tokensCached: 800,
    tokensOutput: 350,
    latencyMs: 4200,
    cacheHit: true,
  },
  toolCall: {
    ...ENVELOPE,
    sequenceNumber: 3,
    eventType: 'toolCall',
    tool: 'Read',
    role: 'gan-generator',
    argumentsRef: 'trace/payloads/0000000003-gan-generator-arguments.json',
    resultRef: 'trace/payloads/0000000003-gan-generator-result.json',
    disposition: 'completed',
    latencyMs: 18,
  },
  safetyHalt: {
    ...ENVELOPE,
    sequenceNumber: 4,
    eventType: 'safetyHalt',
    safetyClass: 'loopDetected',
    role: 'gan-orchestrator',
    payload: { reason: 'noProgress', attempts: 3 },
  },
  trustEvent: {
    ...ENVELOPE,
    sequenceNumber: 5,
    eventType: 'trustEvent',
    promptVariant: 'initialIntroduction',
    userChoice: 'approve',
    contentHash: 'd'.repeat(64),
  },
  validationAbort: {
    ...ENVELOPE,
    sequenceNumber: 6,
    eventType: 'validationAbort',
    validationStage: 'overlay',
    errorCode: 'UntrustedOverlay',
    errorPayload: {
      code: 'UntrustedOverlay',
      message: 'The project overlay has not been trusted for this run.',
      file: '.claude/gan/project.md',
    },
  },
};

describe('run-trace-v1 schema: the seven event classes', () => {
  it('compiles the schema under the pinned ajv strict setup', () => {
    expect(() => getRunTraceValidator()).not.toThrow();
  });

  it('uses a oneOf discriminated union over exactly the seven known classes', () => {

    const allOf = runTraceV1.allOf as Array<Record<string, unknown>>;
    const unionEntry = allOf.find((e) => Array.isArray(e.oneOf));
    expect(unionEntry).toBeTruthy();
    const oneOf = unionEntry!.oneOf as Array<{ $ref: string }>;
    const refNames = oneOf.map((b) => b.$ref.replace('#/definitions/', '')).sort();
    expect(refNames).toEqual(
      [
        'agentAttempt',
        'llmCall',
        'orchestratorMilestone',
        'safetyHalt',
        'toolCall',
        'trustEvent',
        'validationAbort',
      ].sort(),
    );
  });

  for (const [name, event] of Object.entries(VALID_EVENTS)) {
    it(`validates a correct ${name} event`, () => {
      const validate = getRunTraceValidator();
      const ok = validate(event);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }
});

describe('run-trace-v1 schema: malformed / missing-envelope rejection', () => {
  const validate = getRunTraceValidator();

  it('rejects an event missing eventType', () => {
    const { eventType: _drop, ...rest } = VALID_EVENTS.orchestratorMilestone;
    void _drop;
    expect(validate(rest)).toBe(false);
  });

  it('rejects an event with a non-integer sequenceNumber', () => {
    expect(validate({ ...VALID_EVENTS.llmCall, sequenceNumber: 2.5 })).toBe(false);
  });

  it('rejects an event with a negative sequenceNumber', () => {
    expect(validate({ ...VALID_EVENTS.llmCall, sequenceNumber: -1 })).toBe(false);
  });

  it('rejects an event missing a required class-specific field (llmCall.promptRef)', () => {
    const { promptRef: _drop, ...rest } = VALID_EVENTS.llmCall;
    void _drop;
    expect(validate(rest)).toBe(false);
  });

  it('rejects an event missing runId and timestamp', () => {
    expect(
      validate({ sequenceNumber: 0, eventType: 'orchestratorMilestone', milestone: 'sprintStart' }),
    ).toBe(false);
  });
});

describe('run-trace-v1 schema: field-encoding constraints', () => {
  const validate = getRunTraceValidator();

  it('accepts representative valid encodings (already covered by the seven valid events)', () => {
    expect(validate(VALID_EVENTS.agentAttempt)).toBe(true);
    expect(validate(VALID_EVENTS.llmCall)).toBe(true);
  });

  it('rejects an uppercase-hex hash (hashes are lowercase 64-hex)', () => {
    expect(validate({ ...VALID_EVENTS.agentAttempt, inputDigest: 'A'.repeat(64) })).toBe(false);
  });

  it('rejects a 63-char hash (hashes are exactly 64 chars)', () => {
    expect(validate({ ...VALID_EVENTS.agentAttempt, inputDigest: 'a'.repeat(63) })).toBe(false);
  });

  it('rejects a sha256:-prefixed hash (trace fields are BARE hex, no prefix)', () => {
    expect(validate({ ...VALID_EVENTS.llmCall, promptRef: `sha256:${'a'.repeat(64)}` })).toBe(
      false,
    );
  });

  it('rejects a non-UTC timestamp (local timezone offset)', () => {
    expect(
      validate({
        ...VALID_EVENTS.orchestratorMilestone,
        timestamp: '2026-05-21T21:47:20.123+02:00',
      }),
    ).toBe(false);
  });

  it('rejects a timestamp without millisecond precision', () => {
    expect(
      validate({ ...VALID_EVENTS.orchestratorMilestone, timestamp: '2026-05-21T19:47:20Z' }),
    ).toBe(false);
  });

  it('rejects a camelCase role id (role IDs are kebab-case)', () => {
    expect(validate({ ...VALID_EVENTS.llmCall, role: 'ganGenerator' })).toBe(false);
  });

  it('rejects a leading-separator reference path (paths are relative POSIX)', () => {
    expect(validate({ ...VALID_EVENTS.toolCall, argumentsRef: '/abs/x.json' })).toBe(false);
  });

  it('rejects a path-traversal reference path', () => {
    expect(validate({ ...VALID_EVENTS.toolCall, resultRef: '../escape.json' })).toBe(false);
  });
});

const V1_KNOWN_EVENT_TYPES = new Set([
  'orchestratorMilestone',
  'agentAttempt',
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
]);

interface ReaderResult {
  accepted: Array<Record<string, unknown>>;
  warnings: Array<{ reason: string; eventType: unknown; sequenceNumber: unknown }>;
}

function readV1Trace(events: Array<Record<string, unknown>>): ReaderResult {
  const validate = getRunTraceValidator();
  const result: ReaderResult = { accepted: [], warnings: [] };
  for (const event of events) {
    const eventType = event.eventType;
    if (typeof eventType !== 'string' || !V1_KNOWN_EVENT_TYPES.has(eventType)) {
      result.warnings.push({
        reason: 'unknownEventClass',
        eventType,
        sequenceNumber: event.sequenceNumber,
      });
      continue;
    }

    validate(event);
    result.accepted.push(event);
  }
  return result;
}

describe('run-trace-v1 forward-compatibility (F1.2)', () => {
  it('tolerates an unknown-but-additive discriminator value within a known class', () => {

    const validate = getRunTraceValidator();
    const additive = {
      ...ENVELOPE,
      sequenceNumber: 7,
      eventType: 'safetyHalt',
      safetyClass: 'budgetExceeded',
      role: 'gan-orchestrator',
      payload: { reason: 'tokenBudgetExceeded' },
    };
    expect(validate(additive)).toBe(true);

    const out = readV1Trace([additive]);
    expect(out.warnings).toHaveLength(0);
    expect(out.accepted).toHaveLength(1);
  });

  it('skips an unknown event-class type with a structured warning rather than throwing', () => {
    const unknown = {
      ...ENVELOPE,
      sequenceNumber: 8,
      eventType: 'futureUnknownEvent',
      someFutureField: 42,
    };
    let out: ReaderResult | undefined;
    expect(() => {
      out = readV1Trace([VALID_EVENTS.llmCall, unknown, VALID_EVENTS.toolCall]);
    }).not.toThrow();
    expect(out!.accepted).toHaveLength(2);
    expect(out!.warnings).toHaveLength(1);
    expect(out!.warnings[0]).toMatchObject({
      reason: 'unknownEventClass',
      eventType: 'futureUnknownEvent',
      sequenceNumber: 8,
    });
  });
});

describe('run-trace-index-v1 schema (F1.3)', () => {
  const validate = getRunTraceIndexValidator();

  it('validates a complete terminated-run index', () => {
    const index = {
      runId: '20260521T194720-6752',
      totalEvents: 7,
      countByClass: {
        orchestratorMilestone: 2,
        agentAttempt: 1,
        llmCall: 2,
        toolCall: 1,
        validationAbort: 1,
      },
      firstTimestamp: '2026-05-21T19:47:20.123Z',
      lastTimestamp: '2026-05-21T19:52:11.004Z',
      disposition: 'success',
    };
    expect(validate(index), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates an in-progress index (no disposition / no timestamps yet)', () => {
    expect(validate({ runId: 'r1', totalEvents: 0, countByClass: {} })).toBe(true);
  });

  it('rejects an index missing the total event count', () => {
    expect(validate({ runId: 'r1', countByClass: {} })).toBe(false);
  });

  it('rejects an index with a negative per-class count', () => {
    expect(validate({ runId: 'r1', totalEvents: 1, countByClass: { llmCall: -1 } })).toBe(false);
  });

  it('rejects an index with an out-of-enum disposition', () => {
    expect(validate({ runId: 'r1', totalEvents: 0, countByClass: {}, disposition: 'kaboom' })).toBe(
      false,
    );
  });
});

describe('evaluator-evidence-bundle-v1 schema (F1.4)', () => {
  const validate = getEvaluatorEvidenceBundleValidator();

  const passCriterion = {
    name: 'tls_required_for_sensitive_traffic',
    verdict: 'pass',
    evidence: {
      traceEventRefs: ['llmCall:42', 'toolCall:43'],
      reproductionCommand: "rg -n 'http://' src/handler.ts src/auth.ts",
      deltaFromContract: {
        expected: 'no plaintext HTTP for credentialed traffic',
        observed: 'all credentialed callers use https://',
      },
    },
  };
  const failCriterion = {
    name: 'run_trace_index_validates',
    verdict: 'fail',
    evidence: {
      traceEventRefs: ['toolCall:9'],
      reproductionCommand: 'npm test -- run-trace-schema',
      deltaFromContract: {
        expected: 'a valid index validates',
        observed: 'index missing totalEvents was accepted',
      },
    },
  };
  const blockedCriterion = {
    name: 'three_new_schemas_bundled_and_build_compiles',
    verdict: 'blocked',
    evidence: { traceEventRefs: ['orchestratorMilestone:0'] },
  };
  const skippedCriterion = {
    name: 'web_node_tls_required_for_sensitive_traffic',
    verdict: 'skipped',
    evidence: { traceEventRefs: [] },
  };

  const fullBundle = {
    sprintNumber: 1,
    attemptLetter: 'A',
    criteria: [passCriterion, failCriterion, blockedCriterion, skippedCriterion],
    verdictSummary: { totalCriteria: 4, passed: 1, failed: 1, blocked: 1, skipped: 1 },
  };

  it('validates a fully-populated bundle', () => {
    expect(validate(fullBundle), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates a skipped criterion with an empty traceEventRefs', () => {
    expect(validate({ ...fullBundle, criteria: [skippedCriterion] })).toBe(true);
  });

  it('rejects a fail criterion missing reproductionCommand', () => {
    const bad = {
      name: 'x',
      verdict: 'fail',
      evidence: {
        traceEventRefs: ['toolCall:1'],
        deltaFromContract: { expected: 'e', observed: 'o' },
      },
    };
    expect(validate({ ...fullBundle, criteria: [bad] })).toBe(false);
  });

  it('rejects a fail criterion missing deltaFromContract', () => {
    const bad = {
      name: 'x',
      verdict: 'fail',
      evidence: { traceEventRefs: ['toolCall:1'], reproductionCommand: 'npm test' },
    };
    expect(validate({ ...fullBundle, criteria: [bad] })).toBe(false);
  });

  it('rejects a pass criterion missing reproductionCommand', () => {
    const bad = {
      name: 'x',
      verdict: 'pass',
      evidence: { traceEventRefs: ['toolCall:1'] },
    };
    expect(validate({ ...fullBundle, criteria: [bad] })).toBe(false);
  });

  it('rejects a malformed trace reference (eventType not camelCase)', () => {
    const bad = {
      name: 'x',
      verdict: 'skipped',
      evidence: { traceEventRefs: ['LLMCall:1'] },
    };
    expect(validate({ ...fullBundle, criteria: [bad] })).toBe(false);
  });

  it('rejects a multi-letter attemptLetter', () => {
    expect(validate({ ...fullBundle, attemptLetter: 'AA' })).toBe(false);
  });

  it('rejects an out-of-enum verdict', () => {
    const bad = { name: 'x', verdict: 'maybe', evidence: { traceEventRefs: [] } };
    expect(validate({ ...fullBundle, criteria: [bad] })).toBe(false);
  });
});

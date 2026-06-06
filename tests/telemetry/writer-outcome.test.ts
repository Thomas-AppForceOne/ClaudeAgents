/**
 * writeTelemetryOutcome — end-to-end shape, schema-validation, and
 * cost-derivation suite.
 *
 * Covers the four behavioural rules the contract pins on the writer:
 *
 *  - the emitted outcome.json validates against the bundled
 *    telemetryOutcomeV1 schema for a representative fabricated input;
 *  - the embedded disposition equals the mapping-table output for the
 *    supplied terminalReason;
 *  - cost.complete === true when getDroppedEmits is 0 and the cost metrics
 *    match the on-disk trace;
 *  - cost.complete === false after a single incrementDroppedEmits — the
 *    regression guard against deriving complete from reconcileTraceIndex
 *    (a dropped emit leaves an index-reconcilable trace and would be
 *    missed by the reconcile);
 *  - cost === null when no trace directory exists under runDir.
 *
 * The dropped-emits tally is module-level in-memory state, so it is reset
 * before each test to keep cases isolated. Trace fixtures are built by
 * appendTraceEvent — the canonical emit path — so the cost-sum-equality
 * assertion holds against real on-disk events the aggregator reads back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AjvImport, { type ValidateFunction } from 'ajv';

import { writeTelemetryOutcome } from '../../src/telemetry/writer-outcome.js';
import { terminalReasonToDisposition } from '../../src/telemetry/mapping.js';
import { telemetryOutcomeV1 } from '../../src/config-server/schemas-bundled.js';
import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import {
  incrementDroppedEmits,
  resetDroppedEmitsForTests,
} from '../../src/trace/dropped-emits.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

const tmpDirs: string[] = [];
function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-telout-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetDroppedEmitsForTests();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const RUN_ID = '20260606T190000-1234';

// Build a deterministic llmCall event with the schema-required fields. The
// promptRef/responseRef are bare sha256 hex (64-char lowercase) — the run-
// trace schema rejects anything else, and the append path validates against
// it before writing.
function llmCall(seq: number, tokensIn: number, tokensOut: number, tokensCached: number): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-06-06T19:00:0${seq}.000Z`,
    runId: RUN_ID,
    model: 'test-model',
    role: 'gan-generator',
    promptRef: ('a'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    responseRef: ('b'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    tokensInput: tokensIn,
    tokensCached: tokensCached,
    tokensOutput: tokensOut,
    latencyMs: 100,
    cacheHit: false,
  } as TraceEventInput;
}

function toolCall(seq: number): TraceEventInput {
  return {
    eventType: 'toolCall',
    timestamp: `2026-06-06T19:05:0${seq}.000Z`,
    runId: RUN_ID,
    tool: 'someTool',
    role: 'gan-generator',
    argumentsRef: 'payloads/' + String(seq).padStart(10, '0') + '-gan-generator-arguments.json',
    resultRef: 'payloads/' + String(seq).padStart(10, '0') + '-gan-generator-result.json',
    disposition: 'completed',
    latencyMs: 50,
  } as TraceEventInput;
}

function fabricatedSprints(): Array<{
  sprintNumber: number;
  status: 'complete' | 'rejected' | 'halted' | 'aborted' | 'errored';
  attemptCounts: Record<string, number>;
}> {
  return [
    {
      sprintNumber: 1,
      status: 'complete',
      attemptCounts: { 'gan-generator': 1, 'gan-evaluator': 1 },
    },
  ];
}

function compile(): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  return ajv.compile(telemetryOutcomeV1);
}

describe('writeTelemetryOutcome — schema validation and disposition mapping', () => {
  it('emitted outcome.json validates against telemetryOutcomeV1', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0, 100, 50, 10));

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'failed-loop-detected',
      sprints: fabricatedSprints(),
      safetyHalts: [
        { sprintNumber: 1, safetyClass: 'loopDetected', reason: 'editOscillation' },
      ],
      writtenAt: '2026-06-06T19:10:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    const validate = compile();
    const ok = validate(parsed);
    if (!ok) {
      throw new Error(`telemetryOutcomeV1 validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('disposition equals the mapping-table output for the supplied terminalReason', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0, 10, 5, 0));

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'failed-evaluation-rejected',
      sprints: fabricatedSprints(),
      safetyHalts: [],
      writtenAt: '2026-06-06T19:10:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      disposition: string;
      terminalReason: string;
    };
    expect(parsed.terminalReason).toBe('failed-evaluation-rejected');
    expect(parsed.disposition).toBe(terminalReasonToDisposition('failed-evaluation-rejected'));
    expect(parsed.disposition).toBe('rejected');
  });
});

describe('writeTelemetryOutcome — cost.complete derivation', () => {
  it('t-writer-outcome-cost-complete-true: cost.complete === true when droppedEmits is 0', async () => {
    const runDir = makeRunDir();
    // Three llmCall events + one toolCall — every cost field has a non-
    // trivial sum to assert against.
    appendTraceEvent(runDir, llmCall(0, 100, 50, 10));
    appendTraceEvent(runDir, llmCall(1, 200, 100, 20));
    appendTraceEvent(runDir, llmCall(2, 300, 150, 30));
    appendTraceEvent(runDir, toolCall(3));

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'complete',
      sprints: fabricatedSprints(),
      safetyHalts: [],
      writtenAt: '2026-06-06T19:10:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      cost: {
        complete: boolean;
        tokensInput: number;
        tokensCached: number;
        tokensOutput: number;
        llmCallCount: number;
        toolCallCount: number;
        wallClockMs: number;
      } | null;
    };

    expect(parsed.cost).not.toBeNull();
    if (parsed.cost === null) return;
    expect(parsed.cost.complete).toBe(true);
    // Sum-equality with the fabricated trace: token counts add up exactly.
    expect(parsed.cost.tokensInput).toBe(600);
    expect(parsed.cost.tokensOutput).toBe(300);
    expect(parsed.cost.tokensCached).toBe(60);
    expect(parsed.cost.llmCallCount).toBe(3);
    expect(parsed.cost.toolCallCount).toBe(1);
    // Wall-clock span is non-negative; exact value depends on timestamp
    // arithmetic so just pin the contract (non-negative integer).
    expect(Number.isInteger(parsed.cost.wallClockMs)).toBe(true);
    expect(parsed.cost.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it('t-writer-outcome-cost-complete-false: cost.complete === false after incrementDroppedEmits', async () => {
    const runDir = makeRunDir();
    // Even one cost-bearing event is enough — the loss signal is droppedEmits,
    // not the on-disk count. This is the regression guard against a
    // reconcileTraceIndex-based derivation (which would silently report
    // complete: true because the index reconciles fine).
    appendTraceEvent(runDir, llmCall(0, 100, 50, 10));
    incrementDroppedEmits(runDir);

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'complete',
      sprints: fabricatedSprints(),
      safetyHalts: [],
      writtenAt: '2026-06-06T19:10:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      cost: { complete: boolean } | null;
    };
    expect(parsed.cost).not.toBeNull();
    expect(parsed.cost?.complete).toBe(false);
  });

  it('t-writer-outcome-cost-null: cost === null when no trace directory exists', async () => {
    const runDir = makeRunDir();
    // Intentionally do not appendTraceEvent — the trace/events directory
    // does not exist under runDir, so the writer must encode the
    // trace-unavailable degraded path as a literal JSON null rather than
    // an empty object or a partial cost.

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'aborted-by-user',
      sprints: fabricatedSprints(),
      safetyHalts: [],
      writtenAt: '2026-06-06T19:10:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as { cost: unknown };
    expect(parsed.cost).toBeNull();
    // Sanity: cost === null still validates against the schema (cost is
    // typed as oneOf: null | costObject at the top level).
    const validate = compile();
    expect(validate(parsed)).toBe(true);
  });
});

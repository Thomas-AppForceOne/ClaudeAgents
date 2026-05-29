/**
 * aggregateRunSummary suite — sum-equality with the in-memory aggregator,
 * the new `toolCalls` counter, and the in-memory `droppedEmits` source.
 *
 * Covers:
 *  - sum-equality: aggregateRunSummary({ runDir }) numeric fields (except
 *    droppedEmits) equal aggregateSprintSummary(events) over the same on-
 *    disk events;
 *  - the `toolCalls` field equals the count of `toolCall` events;
 *  - `droppedEmits` is `0` on a happy path with no failures;
 *  - `reconcileTraceIndex({ runDir }).totalEvents` equals the file count.
 *
 * Each test constructs a trace by calling appendTraceEvent for the event
 * shapes under test, then aggregates and asserts. The dropped-emits tally
 * is the in-memory module-level state, so resetDroppedEmitsForTests is
 * called between cases to isolate them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import { aggregateRunSummary, aggregateSprintSummary } from '../../src/trace/progress.js';
import { incrementDroppedEmits, resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';
import {
  aggregateRunSummaryTool,
  reconcileTraceIndexTool,
} from '../../src/config-server/tools/trace.js';
import { scanEvents } from '../../src/trace/reconcile.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-agg-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
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
      // best-effort
    }
  }
});

const RUN_ID = '20260522T140000-agg1';

function llmCall(seq: number, tokens: number): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-05-22T14:00:0${seq}.000Z`,
    runId: RUN_ID,
    model: 'claude-test',
    role: 'gan-generator',
    // promptRef/responseRef are sha256 hex per the run-trace-v1 schema
    // (not payload paths). The test fixtures use deterministic 64-char
    // lowercase-hex strings so the schema validator accepts them.
    promptRef: ('a'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    responseRef: ('b'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    tokensInput: tokens,
    tokensCached: 0,
    tokensOutput: tokens * 2,
    latencyMs: 1500,
    cacheHit: false,
  } as TraceEventInput;
}

function toolCall(seq: number): TraceEventInput {
  return {
    eventType: 'toolCall',
    timestamp: `2026-05-22T14:05:0${seq}.000Z`,
    runId: RUN_ID,
    tool: 'someTool',
    role: 'gan-generator',
    argumentsRef: 'payloads/' + String(seq).padStart(10, '0') + '-gan-generator-arguments.json',
    resultRef: 'payloads/' + String(seq).padStart(10, '0') + '-gan-generator-result.json',
    disposition: 'completed',
    latencyMs: 50,
  } as TraceEventInput;
}

function agentAttempt(seq: number): TraceEventInput {
  return {
    eventType: 'agentAttempt',
    timestamp: `2026-05-22T14:10:0${seq}.000Z`,
    runId: RUN_ID,
    role: 'gan-generator',
    attemptNumber: 1,
    inputDigest: 'd'.repeat(64),
    outputArtifactPath: `attempt-${seq}.md`,
    disposition: 'completed',
  } as TraceEventInput;
}

describe('aggregateRunSummary — sum-equality with aggregateSprintSummary', () => {
  it('every shipped SprintSummaryAggregate field (except droppedEmits) equals aggregateSprintSummary over same events', () => {
    const runDir = makeTmp();
    // Mix three event classes so every counter the aggregator owns has
    // something to sum: 2 LLM calls, 1 tool call, 1 agent attempt.
    appendTraceEvent(runDir, llmCall(0, 100));
    appendTraceEvent(runDir, llmCall(1, 200));
    appendTraceEvent(runDir, toolCall(2));
    appendTraceEvent(runDir, agentAttempt(3));

    const traceRoot = path.join(runDir, 'trace');
    const { events } = scanEvents(traceRoot);
    const inMemory = aggregateSprintSummary(events);
    const onDisk = aggregateRunSummary(runDir);

    expect(onDisk.calls).toBe(inMemory.calls);
    expect(onDisk.agents).toBe(inMemory.agents);
    expect(onDisk.toolCalls).toBe(inMemory.toolCalls);
    expect(onDisk.tokensInput).toBe(inMemory.tokensInput);
    expect(onDisk.tokensOutput).toBe(inMemory.tokensOutput);
    expect(onDisk.tokensCached).toBe(inMemory.tokensCached);
    expect(onDisk.elapsedMs).toBe(inMemory.elapsedMs);
    // droppedEmits is the only field allowed to differ — it comes from the
    // in-memory tally, not from the on-disk events.
    expect(onDisk.droppedEmits).toBe(0);
  });
});

describe('aggregateRunSummary — toolCalls counter', () => {
  it('toolCalls equals the count of toolCall events in the input', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, toolCall(0));
    appendTraceEvent(runDir, toolCall(1));
    appendTraceEvent(runDir, toolCall(2));
    appendTraceEvent(runDir, llmCall(3, 10));
    const summary = aggregateRunSummary(runDir);
    expect(summary.toolCalls).toBe(3);
    // Sanity: llmCall is not double-counted.
    expect(summary.calls).toBe(1);
  });

  it('toolCalls is 0 on a trace with no toolCall events', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, llmCall(0, 10));
    appendTraceEvent(runDir, agentAttempt(1));
    const summary = aggregateRunSummary(runDir);
    expect(summary.toolCalls).toBe(0);
  });
});

describe('aggregateRunSummary — droppedEmits source is the in-memory tally', () => {
  it('droppedEmits reflects the in-memory increment, not the on-disk events', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, llmCall(0, 10));
    // Synthetic drop — simulates the emit-failure path the tool handler
    // would have taken.
    incrementDroppedEmits(runDir);
    incrementDroppedEmits(runDir);
    const summary = aggregateRunSummary(runDir);
    expect(summary.droppedEmits).toBe(2);
    // Sum-equality still holds for the on-disk-derived numeric fields.
    expect(summary.calls).toBe(1);
  });
});

describe('aggregateRunSummary — tool-vs-library parity', () => {
  it('aggregateRunSummaryTool handler returns byte-identical object to library aggregateRunSummary', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, llmCall(0, 100));
    appendTraceEvent(runDir, toolCall(1));
    appendTraceEvent(runDir, agentAttempt(2));
    incrementDroppedEmits(runDir);

    const viaTool = aggregateRunSummaryTool({ runDir });
    const viaLib = aggregateRunSummary(runDir);
    // Stable-stringify is overkill here — same keys, same values.
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.droppedEmits).toBe(1);
    expect(viaTool.toolCalls).toBe(1);
  });
});

describe('reconcileTraceIndex — totalEvents equals on-disk event-file count', () => {
  it('happy path: rebuilt index.totalEvents equals scan count', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, llmCall(0, 10));
    appendTraceEvent(runDir, llmCall(1, 20));
    appendTraceEvent(runDir, agentAttempt(2));

    const traceRoot = path.join(runDir, 'trace');
    const { events } = scanEvents(traceRoot);
    const index = reconcileTraceIndexTool({ runDir });
    expect(index.totalEvents).toBe(events.length);
    expect(index.totalEvents).toBe(3);
  });
});

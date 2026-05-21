/**
 * T1 Sprint 3 — the stderr progress-line formatters (F3.5, F3.6, F3.7).
 *
 * Covers contract criteria:
 *  - heartbeat_formatter_exact_string
 *  - per_llm_call_formatter_exact_string (both cache branches; latency form)
 *  - sprint_end_summary_formatter_aggregates_exact_string
 *
 * Every assertion is byte-exact against the spec.md format strings, and each
 * test confirms the output carries metadata only (no payload content: no
 * hashes, no prompt/response text).
 */
import { describe, expect, it } from 'vitest';

import {
  formatHeartbeat,
  formatLlmCallSummary,
  formatWallclock,
  aggregateSprintSummary,
  formatSprintSummary,
  formatSprintSummaryFromEvents,
} from '../../src/trace/progress.js';
import type { TraceEvent } from '../../src/trace/events.js';

const RUN_ID = '20260521T194720-6752';
const SHA = 'a'.repeat(64);

function ts(ms: number): string {
  return new Date(ms).toISOString();
}

describe('heartbeat_formatter_exact_string', () => {
  it('renders [<role>] thinking... verbatim for gan-generator', () => {
    expect(formatHeartbeat('gan-generator')).toBe('[gan-generator] thinking...');
  });

  it('renders the role verbatim for any kebab-case role', () => {
    expect(formatHeartbeat('gan-evaluator')).toBe('[gan-evaluator] thinking...');
    expect(formatHeartbeat('gan-contract-proposer')).toBe('[gan-contract-proposer] thinking...');
  });

  it('carries no token counts, latency, or payload content', () => {
    const out = formatHeartbeat('gan-generator');
    expect(out).toBe('[gan-generator] thinking...');
    expect(out).not.toMatch(/\d/); // no numeric metadata
    expect(out).not.toContain('cache');
    expect(out).not.toContain(SHA);
  });

  it('is pure (same input -> same output)', () => {
    expect(formatHeartbeat('gan-generator')).toBe(formatHeartbeat('gan-generator'));
  });
});

describe('per_llm_call_formatter_exact_string', () => {
  it('renders the cache-hit branch byte-exact', () => {
    const line = formatLlmCallSummary({
      role: 'gan-generator',
      tokensInput: 1200,
      tokensOutput: 350,
      tokensCached: 800,
      latencyMs: 2500,
      cacheHit: true,
    });
    expect(line).toBe('[gan-generator] 1200 in / 350 out / 800 cached / 2.5s [cache hit]');
  });

  it('renders the cache-miss branch byte-exact', () => {
    const line = formatLlmCallSummary({
      role: 'gan-evaluator',
      tokensInput: 4096,
      tokensOutput: 512,
      tokensCached: 0,
      latencyMs: 8341,
      cacheHit: false,
    });
    // spec example: 8341ms -> 8.3s
    expect(line).toBe('[gan-evaluator] 4096 in / 512 out / 0 cached / 8.3s [cache miss]');
  });

  it('renders latencyMs/1000 with one decimal place (spec form)', () => {
    const line = formatLlmCallSummary({
      role: 'r',
      tokensInput: 1,
      tokensOutput: 1,
      tokensCached: 1,
      latencyMs: 8341,
      cacheHit: true,
    });
    expect(line).toContain(' 8.3s ');
  });

  it('emits no payload content (no hash, no prompt/response text)', () => {
    const line = formatLlmCallSummary({
      role: 'gan-generator',
      tokensInput: 1200,
      tokensOutput: 350,
      tokensCached: 800,
      latencyMs: 2500,
      cacheHit: true,
    });
    expect(line).not.toContain(SHA);
    expect(line).not.toMatch(/prompt|response|payloads\//i);
  });
});

describe('sprint_end_summary_formatter_aggregates_exact_string', () => {
  function llmCall(seq: number, timeMs: number, ti: number, to: number, tc: number): TraceEvent {
    return {
      sequenceNumber: seq,
      eventType: 'llmCall',
      timestamp: ts(timeMs),
      runId: RUN_ID,
      model: 'm',
      role: 'gan-generator',
      promptRef: SHA,
      responseRef: SHA,
      tokensInput: ti,
      tokensCached: tc,
      tokensOutput: to,
      latencyMs: 10,
      cacheHit: false,
    } as TraceEvent;
  }

  function agentAttempt(seq: number, timeMs: number, role: string, n: number): TraceEvent {
    return {
      sequenceNumber: seq,
      eventType: 'agentAttempt',
      timestamp: ts(timeMs),
      runId: RUN_ID,
      role,
      attemptNumber: n,
      inputDigest: SHA,
      outputArtifactPath: 'a.json',
      disposition: 'completed',
    } as TraceEvent;
  }

  it('aggregates counts/sums/wallclock and renders the line byte-exact', () => {
    const base = Date.parse('2026-05-21T19:47:20.000Z');
    const events: TraceEvent[] = [
      agentAttempt(0, base, 'gan-generator', 1),
      llmCall(1, base + 1000, 1200, 350, 800),
      llmCall(2, base + 2000, 4096, 512, 0),
      agentAttempt(3, base + 3000, 'gan-evaluator', 1),
      llmCall(4, base + 4000, 100, 50, 25),
      // 4m23s span: last event at base + 263_000ms (263s = 4m23s)
      agentAttempt(5, base + 263_000, 'gan-generator', 2),
    ];

    const agg = aggregateSprintSummary(events);
    expect(agg.calls).toBe(3);
    expect(agg.agents).toBe(3);
    expect(agg.tokensInput).toBe(1200 + 4096 + 100);
    expect(agg.tokensOutput).toBe(350 + 512 + 50);
    expect(agg.tokensCached).toBe(800 + 0 + 25);
    expect(agg.elapsedMs).toBe(263_000);

    const line = formatSprintSummary(agg);
    expect(line).toBe('[sprint-summary] 3/3 LLM calls / 5396 in / 912 out / 825 cached / 4m23s');
  });

  it('renders sub-minute wallclock as <seconds>s and one-shot via formatSprintSummaryFromEvents', () => {
    const base = Date.parse('2026-05-21T19:47:20.000Z');
    const events: TraceEvent[] = [
      agentAttempt(0, base, 'gan-generator', 1),
      llmCall(1, base + 42_000, 10, 5, 0),
    ];
    const line = formatSprintSummaryFromEvents(events);
    expect(line).toBe('[sprint-summary] 1/1 LLM calls / 10 in / 5 out / 0 cached / 42s');
  });

  it('emits metadata only (no payload content) and no dollar cost', () => {
    const base = Date.parse('2026-05-21T19:47:20.000Z');
    const events: TraceEvent[] = [
      agentAttempt(0, base, 'gan-generator', 1),
      llmCall(1, base + 1000, 1, 1, 1),
    ];
    const line = formatSprintSummaryFromEvents(events);
    expect(line).not.toContain(SHA);
    expect(line).not.toContain('$');
  });

  it('an empty trace renders 0/0 with 0s wallclock', () => {
    const agg = aggregateSprintSummary([]);
    expect(agg).toEqual({
      calls: 0,
      agents: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCached: 0,
      elapsedMs: 0,
    });
    expect(formatSprintSummary(agg)).toBe(
      '[sprint-summary] 0/0 LLM calls / 0 in / 0 out / 0 cached / 0s',
    );
  });
});

describe('formatWallclock styles', () => {
  it('renders hours/minutes/seconds, minutes/seconds, and bare seconds', () => {
    expect(formatWallclock(263_000)).toBe('4m23s');
    expect(formatWallclock(42_000)).toBe('42s');
    expect(formatWallclock(0)).toBe('0s');
    expect(formatWallclock(3_661_000)).toBe('1h1m1s');
    expect(formatWallclock(60_000)).toBe('1m0s');
  });
});

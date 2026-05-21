/**
 * T1 Sprint 3 — the real-time stderr progress surface (F3.5, F3.6, F3.7).
 *
 * Three PURE formatting functions that produce the exact stderr lines the
 * spec pins. They are metadata-only by construction: each reads operational
 * fields (role, token counts, latency, cache-hit status, counts/sums) and
 * NEVER touches payload content (no prompt/response text, no hashes). The
 * orchestrator wires these to stderr (the live wiring is documented in
 * `skills/gan/SKILL.md`); here they are unit-testable string builders with
 * no I/O.
 *
 * Logging hygiene (spec "Logging hygiene" / "Stderr emission"): the progress
 * surface must never emit payload content. These functions accept only the
 * metadata fields, so a payload value cannot reach the output even by mistake.
 */

import type { AgentAttemptEvent, LlmCallEvent, TraceEvent } from './events.js';

/**
 * The metadata an `llmCall` summary line reads. A structural subset of
 * `LlmCallEvent` so a caller can pass either a full event or just the metric
 * fields — and so the type system forbids passing payload references in.
 */
export interface LlmCallMetrics {
  role: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCached: number;
  latencyMs: number;
  cacheHit: boolean;
}

/**
 * Render the latency in the spec's documented seconds form: `latencyMs/1000`
 * with one decimal place (e.g. 2500 -> `2.5`, 8341 -> `8.3`). The trailing
 * `s` is appended by the caller's format string.
 */
function renderSeconds(latencyMs: number): string {
  return (latencyMs / 1000).toFixed(1);
}

/**
 * F3.5 — the agent-attempt heartbeat line, EXACTLY `[<role>] thinking...`.
 * Metadata-only: it carries the role and nothing else (no tokens, no
 * latency, no payload). Emitted once per attempt, before the first LLM call.
 */
export function formatHeartbeat(role: string): string {
  return `[${role}] thinking...`;
}

/**
 * F3.6 — the per-LLM-call summary line, EXACTLY:
 *   `[<role>] <tokensInput> in / <tokensOutput> out / <tokensCached> cached / <latencyMs/1000>s [hit|miss]`
 *
 * The trailing bracket is `[hit]` when `cacheHit` is true and `[miss]` when
 * false, matching the spec's worked examples (e.g.
 * `[gan-planner] 4827 in / 612 out / 3201 cached / 8.3s [hit]`). Reads only the
 * metric fields of an `llmCall` event; the `promptRef`/`responseRef` content is
 * never consulted.
 */
export function formatLlmCallSummary(metrics: LlmCallMetrics): string {
  const cache = metrics.cacheHit ? 'hit' : 'miss';
  return (
    `[${metrics.role}] ${metrics.tokensInput} in / ${metrics.tokensOutput} out / ` +
    `${metrics.tokensCached} cached / ${renderSeconds(metrics.latencyMs)}s [${cache}]`
  );
}

/**
 * Render an elapsed wall-clock duration in the spec's `<wallclock>` style
 * (e.g. `4m23s`). Whole seconds; minutes shown only when at least one minute
 * has elapsed. Sub-minute durations render as `<seconds>s` (e.g. `42s`);
 * durations of an hour or more render as `<h>h<m>m<s>s`.
 */
export function formatWallclock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** The aggregate a sprint-end summary line reports. */
export interface SprintSummaryAggregate {
  /** Count of `llmCall` events. */
  calls: number;
  /** Count of distinct agent attempts (`agentAttempt` events). */
  agents: number;
  /** Summed `tokensInput` across the `llmCall` events. */
  tokensInput: number;
  /** Summed `tokensOutput` across the `llmCall` events. */
  tokensOutput: number;
  /** Summed `tokensCached` across the `llmCall` events. */
  tokensCached: number;
  /** Elapsed wall-clock across the trace, in milliseconds. */
  elapsedMs: number;
}

/**
 * Aggregate the sprint-end metrics from a set of trace events: count the
 * `llmCall` events, count the `agentAttempt` events, sum the three token
 * metrics across the LLM calls, and compute the elapsed wall-clock as the
 * span between the earliest and latest event timestamps. Pure: it reads only
 * operational metadata (counts, sums, timestamps), never payload content.
 */
export function aggregateSprintSummary(events: readonly TraceEvent[]): SprintSummaryAggregate {
  let calls = 0;
  let agents = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCached = 0;
  let firstMs: number | undefined;
  let lastMs: number | undefined;

  for (const ev of events) {
    const ms = Date.parse(ev.timestamp);
    if (Number.isFinite(ms)) {
      if (firstMs === undefined || ms < firstMs) firstMs = ms;
      if (lastMs === undefined || ms > lastMs) lastMs = ms;
    }
    if (ev.eventType === 'llmCall') {
      const call = ev as LlmCallEvent;
      calls += 1;
      tokensInput += call.tokensInput;
      tokensOutput += call.tokensOutput;
      tokensCached += call.tokensCached;
    } else if (ev.eventType === 'agentAttempt') {
      // Count one per agentAttempt event (one per agent invocation, F2.2).
      void (ev as AgentAttemptEvent);
      agents += 1;
    }
  }

  const elapsedMs = firstMs !== undefined && lastMs !== undefined ? lastMs - firstMs : 0;
  return { calls, agents, tokensInput, tokensOutput, tokensCached, elapsedMs };
}

/**
 * F3.7 — the sprint-end cumulative summary line, EXACTLY:
 *   `[sprint-summary] <calls>/<agents> LLM calls / <in> in / <out> out / <cached> cached / <wallclock>`
 *
 * Accepts a pre-computed aggregate so the formatting stays a pure string
 * builder; callers typically pipe `aggregateSprintSummary(events)` straight
 * in. Dollar cost is NOT surfaced (deferred to T2).
 */
export function formatSprintSummary(aggregate: SprintSummaryAggregate): string {
  return (
    `[sprint-summary] ${aggregate.calls}/${aggregate.agents} LLM calls / ` +
    `${aggregate.tokensInput} in / ${aggregate.tokensOutput} out / ` +
    `${aggregate.tokensCached} cached / ${formatWallclock(aggregate.elapsedMs)}`
  );
}

/**
 * Convenience: aggregate a set of trace events and render the sprint-end
 * summary line in one call.
 */
export function formatSprintSummaryFromEvents(events: readonly TraceEvent[]): string {
  return formatSprintSummary(aggregateSprintSummary(events));
}

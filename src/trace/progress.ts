

import type { AgentAttemptEvent, LlmCallEvent, TraceEvent } from './events.js';

export interface LlmCallMetrics {
  role: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCached: number;
  latencyMs: number;
  cacheHit: boolean;
}

function renderSeconds(latencyMs: number): string {
  return (latencyMs / 1000).toFixed(1);
}

export function formatHeartbeat(role: string): string {
  return `[${role}] thinking...`;
}

export function formatLlmCallSummary(metrics: LlmCallMetrics): string {
  const cache = metrics.cacheHit ? 'hit' : 'miss';
  return (
    `[${metrics.role}] ${metrics.tokensInput} in / ${metrics.tokensOutput} out / ` +
    `${metrics.tokensCached} cached / ${renderSeconds(metrics.latencyMs)}s [${cache}]`
  );
}

export function formatWallclock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export interface SprintSummaryAggregate {

  calls: number;

  agents: number;

  tokensInput: number;

  tokensOutput: number;

  tokensCached: number;

  elapsedMs: number;
}

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

      void (ev as AgentAttemptEvent);
      agents += 1;
    }
  }

  const elapsedMs = firstMs !== undefined && lastMs !== undefined ? lastMs - firstMs : 0;
  return { calls, agents, tokensInput, tokensOutput, tokensCached, elapsedMs };
}

export function formatSprintSummary(aggregate: SprintSummaryAggregate): string {
  return (
    `[sprint-summary] ${aggregate.calls}/${aggregate.agents} LLM calls / ` +
    `${aggregate.tokensInput} in / ${aggregate.tokensOutput} out / ` +
    `${aggregate.tokensCached} cached / ${formatWallclock(aggregate.elapsedMs)}`
  );
}

export function formatSprintSummaryFromEvents(events: readonly TraceEvent[]): string {
  return formatSprintSummary(aggregateSprintSummary(events));
}

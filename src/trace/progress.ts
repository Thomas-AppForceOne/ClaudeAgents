/**
 * Human-readable progress strings derived from trace data.
 *
 * These helpers turn raw metrics and event streams into the one-line status
 * messages a `/gan` run prints to the user (heartbeats, per-call summaries,
 * end-of-sprint roll-ups). They are presentation-only: pure functions with no
 * I/O and no side effects, so they are trivially testable and safe to call from
 * anywhere. The aggregation here is deliberately tolerant of partial/empty
 * input — a roll-up over zero events yields a well-formed zero summary rather
 * than throwing.
 */

import path from 'node:path';

import { getDroppedEmits } from './dropped-emits.js';
import type { AgentAttemptEvent, LlmCallEvent, ToolCallEvent, TraceEvent } from './events.js';
import { scanEvents } from './reconcile.js';

/**
 * Per-call metrics for a single LLM call summary line.
 *
 * @property role the agent role that made the call.
 * @property tokensInput / tokensOutput / tokensCached token accounting.
 * @property latencyMs call duration in milliseconds.
 * @property cacheHit whether the call hit the prompt cache.
 */
export interface LlmCallMetrics {
  role: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCached: number;
  latencyMs: number;
  cacheHit: boolean;
}

// Render a millisecond duration as fixed one-decimal seconds (e.g. 1500 → "1.5").
function renderSeconds(latencyMs: number): string {
  return (latencyMs / 1000).toFixed(1);
}

/**
 * The "still working" heartbeat line for a role, e.g. `[gan-generator]
 * thinking...`. Pure; takes no metrics.
 */
export function formatHeartbeat(role: string): string {
  return `[${role}] thinking...`;
}

/**
 * Format a one-line summary of a completed LLM call: role, token in/out/cached
 * counts, latency in seconds, and a `[hit]`/`[miss]` cache marker. Pure.
 */
export function formatLlmCallSummary(metrics: LlmCallMetrics): string {
  const cache = metrics.cacheHit ? 'hit' : 'miss';
  return (
    `[${metrics.role}] ${metrics.tokensInput} in / ${metrics.tokensOutput} out / ` +
    `${metrics.tokensCached} cached / ${renderSeconds(metrics.latencyMs)}s [${cache}]`
  );
}

/**
 * Format an elapsed duration as a compact wall-clock string, omitting
 * higher units that are zero: `5s`, `2m5s`, or `1h2m5s`. A negative input is
 * clamped to `0s`, so callers need not guard against clock skew.
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

/**
 * Roll-up totals across a sprint's events.
 *
 * @property calls number of LLM-call events.
 * @property agents number of agent-attempt events.
 * @property toolCalls number of `toolCall` events. Counted alongside `calls`
 *   and `agents` because the runtime now records tool invocations explicitly
 *   and the per-run summary surfaces the count for cost / observability
 *   reporting.
 * @property tokensInput / tokensOutput / tokensCached summed token counts
 *   across all LLM calls.
 * @property elapsedMs span between the first and last timestamped event; `0`
 *   when fewer than two timestamps are present.
 */
export interface SprintSummaryAggregate {
  calls: number;

  agents: number;

  toolCalls: number;

  tokensInput: number;

  tokensOutput: number;

  tokensCached: number;

  elapsedMs: number;
}

/**
 * Fold an event stream into a {@link SprintSummaryAggregate}: count LLM calls
 * and agent attempts, sum token usage, and compute the wall-clock span from the
 * earliest to latest parseable timestamp.
 *
 * @param events the run's events (read-only); order does not matter.
 * @returns the aggregate; an empty stream yields all-zero totals (never throws).
 *
 * Non-parseable timestamps are skipped for the span calculation, so one
 * malformed event cannot collapse `elapsedMs` to a bogus value.
 */
export function aggregateSprintSummary(events: readonly TraceEvent[]): SprintSummaryAggregate {
  let calls = 0;
  let agents = 0;
  let toolCalls = 0;
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
      // We only count agent attempts, none of their fields feed the aggregate.
      // The narrowing cast + void documents that the type was checked while
      // making the deliberate non-use explicit (satisfies no-unused-expressions).
      void (ev as AgentAttemptEvent);
      agents += 1;
    } else if (ev.eventType === 'toolCall') {
      // Same shape as the agentAttempt branch: count-only, no fields feed
      // the aggregate. The single counting loop here is the only place
      // toolCalls is computed — the runtime tool layer reads the field this
      // loop writes, never re-counts independently.
      void (ev as ToolCallEvent);
      toolCalls += 1;
    }
  }

  const elapsedMs = firstMs !== undefined && lastMs !== undefined ? lastMs - firstMs : 0;
  return { calls, agents, toolCalls, tokensInput, tokensOutput, tokensCached, elapsedMs };
}

/**
 * Format a pre-computed {@link SprintSummaryAggregate} into the one-line
 * `[sprint-summary] …` roll-up. Pure.
 */
export function formatSprintSummary(aggregate: SprintSummaryAggregate): string {
  return (
    `[sprint-summary] ${aggregate.calls}/${aggregate.agents} LLM calls / ` +
    `${aggregate.tokensInput} in / ${aggregate.tokensOutput} out / ` +
    `${aggregate.tokensCached} cached / ${formatWallclock(aggregate.elapsedMs)}`
  );
}

/**
 * Convenience composition: aggregate `events` and format the roll-up in one
 * call. Equivalent to `formatSprintSummary(aggregateSprintSummary(events))`.
 */
export function formatSprintSummaryFromEvents(events: readonly TraceEvent[]): string {
  return formatSprintSummary(aggregateSprintSummary(events));
}

/**
 * Disk-reading wrapper over {@link formatSprintSummaryFromEvents}: scan the
 * run's trace events directory, then format the one-line roll-up.
 *
 * @param runDir absolute path to the run directory. The trace root
 *   (`<runDir>/trace`) is computed internally so callers never construct it.
 * @returns the `[sprint-summary] …` string the in-memory formatter would
 *   produce for the same events.
 *
 * Failure modes: an absent / unreadable trace directory yields the empty
 * roll-up (`scanEvents` tolerates the missing directory by returning an
 * empty result), so the call is safe on a fresh run dir. Per-file scan
 * failures are folded into corruption counters by `scanEvents` and do not
 * propagate here.
 */
export function runSprintSummary(runDir: string): string {
  const traceRoot = path.join(runDir, 'trace');
  const { events } = scanEvents(traceRoot);
  return formatSprintSummaryFromEvents(events);
}

/**
 * Extended sprint-summary aggregate returned by {@link aggregateRunSummary}.
 *
 * The shape is the existing {@link SprintSummaryAggregate} (now including
 * `toolCalls`) plus the in-memory per-run `droppedEmits` tally — the only
 * field that does **not** come from the events on disk. Holding the two
 * facts in one object lets a single tool call surface both the trace's own
 * counts and the runtime's drop signal at the same wall-clock instant.
 *
 * @property droppedEmits the count of emit failures the long-lived
 *   config-server process has recorded for this `runDir`. **In-memory**:
 *   a separate Node process that imports `aggregateRunSummary` will see
 *   `0` here even when this process's tally is positive. The on-disk
 *   alternative was rejected because the failure domain it exists to flag
 *   (a disk-full or unwritable run dir) would also prevent the counter
 *   itself from being written.
 */
export interface RunSummaryAggregate extends SprintSummaryAggregate {
  droppedEmits: number;
}

/**
 * Disk-reading wrapper over {@link aggregateSprintSummary} that also reads
 * the in-memory `droppedEmits` tally from the long-lived config-server
 * process.
 *
 * @param runDir absolute path to the run directory. The trace root
 *   (`<runDir>/trace`) is computed internally so callers never construct it.
 * @returns the extended aggregate — every shipped `SprintSummaryAggregate`
 *   numeric field equals `aggregateSprintSummary(events)` over the events
 *   read from disk; `droppedEmits` is read from {@link getDroppedEmits},
 *   not derived from the on-disk events (a dropped emit by definition
 *   leaves no trace).
 *
 * Side effects: a directory scan of `<runDir>/trace/events/`; no writes.
 */
export function aggregateRunSummary(runDir: string): RunSummaryAggregate {
  const traceRoot = path.join(runDir, 'trace');
  const { events } = scanEvents(traceRoot);
  const base = aggregateSprintSummary(events);
  return { ...base, droppedEmits: getDroppedEmits(runDir) };
}

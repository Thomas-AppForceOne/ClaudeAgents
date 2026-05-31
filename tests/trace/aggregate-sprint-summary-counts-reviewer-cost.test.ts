/**
 * Acceptance test for the "reviewer is off-budget, not cost-free" property.
 *
 * The independent reviewer does not emit a budget-bearing `agentAttempt`
 * event — it emits an `independentReview` marker — but its underlying LLM
 * call still emits a normal `llmCall` event. The shipped
 * `aggregateSprintSummary` sums every `llmCall` event regardless of which
 * role emitted it, so the reviewer's cost is automatically counted; no
 * aggregator change is required for this sprint. This test locks that
 * behaviour in so a future aggregator change that filters by role (e.g. to
 * exclude reviewer cost) would fail it.
 *
 * The fixture is the smallest event list that demonstrates the property:
 * one reviewer-tagged `agentAttempt` (a stand-in tag — the role string is
 * the load-bearing field) plus an associated `llmCall` tagged for the same
 * role. The assertion is that the aggregator's `tokensInput` /
 * `tokensOutput` / `tokensCached` and `calls` counters include the
 * reviewer's contribution.
 */

import { describe, expect, it } from 'vitest';

import { aggregateSprintSummary } from '../../src/trace/progress.js';
import type {
  AgentAttemptEvent,
  LlmCallEvent,
  TraceEvent,
} from '../../src/trace/events.js';

const ENVELOPE = {
  runId: '20260530T230000-cost',
} as const;

// The reviewer's logical role name in the trace. The independent reviewer
// role uses `gan-reviewer-independent` (per the spec's "Schema and surface
// additions" — the agent prompt's frontmatter `name`). Tagging both the
// agentAttempt and the llmCall with this role models the trace shape a real
// reviewer run produces.
const REVIEWER_ROLE = 'gan-reviewer-independent';

const GENERATOR_ROLE = 'gan-generator';

function generatorAttempt(seq: number): AgentAttemptEvent {
  return {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: `2026-05-30T23:00:0${seq}.000Z`,
    ...ENVELOPE,
    role: GENERATOR_ROLE,
    attemptNumber: 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: 'sprint-2-output.json',
    disposition: 'completed',
  };
}

function generatorLlmCall(seq: number): LlmCallEvent {
  return {
    sequenceNumber: seq,
    eventType: 'llmCall',
    timestamp: `2026-05-30T23:00:0${seq}.000Z`,
    ...ENVELOPE,
    model: 'claude-opus-4',
    role: GENERATOR_ROLE,
    promptRef: 'b'.repeat(64),
    responseRef: 'c'.repeat(64),
    tokensInput: 1000,
    tokensCached: 0,
    tokensOutput: 200,
    latencyMs: 1500,
    cacheHit: false,
  };
}

// A reviewer-tagged agentAttempt — included in the fixture even though the
// reviewer is meant to be off-budget. The proper way to keep the reviewer
// off-budget is for the orchestrator never to emit `agentAttempt` for it
// (the `independentReview` marker stands in instead); this fixture
// deliberately includes a reviewer-tagged agentAttempt so the test can
// distinguish the two layered claims: (a) `aggregateSprintSummary` counts
// reviewer cost from `llmCall` independently of `agentAttempt` (the
// load-bearing claim), and (b) `agentAttempt` counts are not the source of
// truth for cost. A future regression that tries to filter the cost roll-up
// by role would fail this test.
function reviewerAttempt(seq: number): AgentAttemptEvent {
  return {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: `2026-05-30T23:00:0${seq}.000Z`,
    ...ENVELOPE,
    role: REVIEWER_ROLE,
    attemptNumber: 1,
    inputDigest: 'd'.repeat(64),
    outputArtifactPath: 'sprint-2-independent-review-A.json',
    disposition: 'completed',
  };
}

function reviewerLlmCall(seq: number): LlmCallEvent {
  return {
    sequenceNumber: seq,
    eventType: 'llmCall',
    timestamp: `2026-05-30T23:00:0${seq}.000Z`,
    ...ENVELOPE,
    model: 'claude-opus-4',
    role: REVIEWER_ROLE,
    promptRef: 'e'.repeat(64),
    responseRef: 'f'.repeat(64),
    // Distinct, easy-to-attribute token counts so the assertions can
    // separately recognise the reviewer's contribution from the generator's.
    tokensInput: 500,
    tokensCached: 100,
    tokensOutput: 75,
    latencyMs: 800,
    cacheHit: false,
  };
}

describe('aggregateSprintSummary — reviewer llmCall counts toward sprint cost', () => {
  it("sums the reviewer's tokens alongside the generator's (no role filter)", () => {
    const events: readonly TraceEvent[] = [
      generatorAttempt(1),
      generatorLlmCall(2),
      reviewerAttempt(3),
      reviewerLlmCall(4),
    ];

    const aggregate = aggregateSprintSummary(events);

    // Both LLM calls must be counted (calls === 2), and the token sums must
    // include both roles' contributions. The exact numeric checks make the
    // attribution unambiguous.
    expect(aggregate.calls).toBe(2);
    expect(aggregate.tokensInput).toBe(1500); // 1000 generator + 500 reviewer
    expect(aggregate.tokensOutput).toBe(275); // 200 generator + 75 reviewer
    expect(aggregate.tokensCached).toBe(100); // 0 generator + 100 reviewer
  });

  it("the reviewer's llmCall is counted even when no generator llmCall is present", () => {
    // An edge case: a sprint where only the reviewer's cost shows up (e.g.
    // the generator's earlier attempt was elsewhere). The reviewer's cost
    // must still surface in the aggregate.
    const events: readonly TraceEvent[] = [reviewerAttempt(1), reviewerLlmCall(2)];

    const aggregate = aggregateSprintSummary(events);

    expect(aggregate.calls).toBe(1);
    expect(aggregate.tokensInput).toBe(500);
    expect(aggregate.tokensOutput).toBe(75);
    expect(aggregate.tokensCached).toBe(100);
  });

  it("agent count covers both roles' agentAttempt events (reviewer's tagged agentAttempt counts as well, if emitted)", () => {
    // Documents the boundary: the aggregator's `agents` counter is a count
    // of `agentAttempt` events, not a budget-aware filter. The orchestrator
    // keeps the reviewer off-budget by NOT emitting `agentAttempt` for it
    // — the `independentReview` marker is the reviewer's audit record.
    // This assertion guards the aggregator's behaviour rather than the
    // orchestrator's: were the orchestrator to mis-emit a reviewer
    // `agentAttempt`, the aggregator would count it (correctly), and this
    // test would still pass — the budget guard lives elsewhere.
    const events: readonly TraceEvent[] = [
      generatorAttempt(1),
      generatorLlmCall(2),
      reviewerAttempt(3),
      reviewerLlmCall(4),
    ];

    const aggregate = aggregateSprintSummary(events);
    expect(aggregate.agents).toBe(2);
  });
});

/**
 * TS-additive contract guard for SprintSummaryAggregate and RunSummaryAggregate.
 *
 * Why this exists: R7 added `toolCalls` to `SprintSummaryAggregate` and
 * `droppedEmits` to `RunSummaryAggregate`. The shipped aggregator always
 * populates both fields, but the *type* declares them optional so external
 * TS constructors (test fixtures, adapter shims, hand-rolled mirrors) stay
 * source-compatible across additive bumps — the TS analog of the
 * additive-stays-`vN` schema-discipline rule, recorded in
 * PROJECT_CONTEXT § Conventions ("Schema discipline — TS analog").
 *
 * This suite locks the constructor-side contract by constructing aggregate
 * literals *without* the two added fields, annotated against the public
 * types. If a future edit re-tightens either field to required, this file
 * stops compiling — `npm run typecheck` is the gate.
 *
 * The producer-side contract (the aggregator always populates both fields)
 * is locked by `tests/trace/progress.test.ts` and
 * `tests/trace/aggregate-run-summary.test.ts`; this file is exclusively the
 * constructor-side proof.
 */
import { describe, expect, it } from 'vitest';

import type { RunSummaryAggregate, SprintSummaryAggregate } from '../../src/trace/progress.js';

describe('TS-additive contract: SprintSummaryAggregate / RunSummaryAggregate', () => {
  it('SprintSummaryAggregate literal compiles without the additive `toolCalls` field', () => {
    // Annotated literal — the absence of `toolCalls` must remain source-
    // compatible. If `toolCalls` is re-tightened to required, this declaration
    // stops compiling (the test is a typecheck assertion, not a runtime one).
    const aggregate: SprintSummaryAggregate = {
      calls: 0,
      agents: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCached: 0,
      elapsedMs: 0,
    };
    expect(aggregate.toolCalls).toBeUndefined();
  });

  it('RunSummaryAggregate literal compiles without the additive `toolCalls` or `droppedEmits` fields', () => {
    // RunSummaryAggregate extends SprintSummaryAggregate, so this literal
    // proves *both* additive fields are constructor-optional.
    const aggregate: RunSummaryAggregate = {
      calls: 0,
      agents: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCached: 0,
      elapsedMs: 0,
    };
    expect(aggregate.toolCalls).toBeUndefined();
    expect(aggregate.droppedEmits).toBeUndefined();
  });
});

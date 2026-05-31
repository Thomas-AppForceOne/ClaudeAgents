/**
 * Input→event round-trip tests for the additive `contractRevision` field on
 * `agentAttempt` events.
 *
 * The sibling `agentAttempt-contractRevision.test.ts` suite pins the schema
 * layer (a producer that constructs raw events with/without the field is
 * accepted or rejected as the spec promises). This suite pins the (c)↔(d)
 * edge of the four-place wiring quadrant the schema layer cannot see — the
 * `AgentAttemptInput` → `emitAgentAttempt` body → `AgentAttemptEvent` copy
 * step. Without an executable guard here, the producer-side literal can
 * silently drop the field while every schema-level assertion still passes
 * (the exact regression class root-cause analysis I-009 identified).
 *
 * Two cases:
 * 1. When `contractRevision` is set on the input it appears verbatim on the
 *    returned event — proves the conditional copy fires.
 * 2. When `contractRevision` is omitted from the input the key is absent from
 *    the event (`'contractRevision' in event === false`, not `=== undefined`)
 *    — pins the "no undefined keys" property the typed emitter promises so a
 *    persisted event JSON object never carries a dangling `undefined` value
 *    a downstream consumer would have to disambiguate from "absent".
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TraceEmitter } from '../../src/trace/emitter.js';

const tmpDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-trace-'));
  tmpDirs.push(dir);
  return path.join(dir, 'trace');
}

// Monotonic +1ms-per-tick clock — keeps timestamps deterministic without
// mocking globals. Mirrors the helper in tests/trace/emitter.test.ts.
function fixedClock(): () => number {
  let t = Date.parse('2026-05-31T06:48:47.000Z');
  return () => {
    t += 1;
    return t;
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const RUN_ID = '20260531T064847-c6b';

describe('emitAgentAttempt — contractRevision input→event propagation', () => {
  it('stamps contractRevision on the event when the input carries it', () => {
    const emitter = new TraceEmitter({ traceRoot: makeRoot(), runId: RUN_ID }, fixedClock());
    const event = emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { contract: 'sprint-2' },
      outputArtifactPath: 'attempt.json',
      disposition: 'completed',
      contractRevision: 3,
    });
    expect(event.contractRevision).toBe(3);
  });

  it('omits contractRevision from the event when the input omits it', () => {
    const emitter = new TraceEmitter({ traceRoot: makeRoot(), runId: RUN_ID }, fixedClock());
    const event = emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { contract: 'sprint-2' },
      outputArtifactPath: 'attempt.json',
      disposition: 'completed',
    });
    // The key MUST be absent, not present-with-undefined. This pins the
    // "no undefined keys" property the conditional-copy pattern promises so
    // a downstream `'contractRevision' in event` check disambiguates from
    // "explicitly set to undefined" cleanly.
    expect('contractRevision' in event).toBe(false);
  });
});

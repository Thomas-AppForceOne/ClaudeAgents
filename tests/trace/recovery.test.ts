/**
 * T1 Sprint 3 — recovery continuation (F3.8).
 *
 * Covers contract criteria:
 *  - recovery_sequence_continuation_and_attempt_reconstruction
 *  - web_node_prototype_pollution (the recovery fold reuses scanEvents' guard)
 *
 * Two reconstructions, both purely from the existing trace (no external
 * counter file):
 *  (a) the resume sequence is one more than the highest present sequence, and
 *      a TraceEmitter constructed with that startSequence continues gaplessly;
 *  (b) per-role attempt-counter state equals the count (and highest
 *      attemptNumber) of agentAttempt events for that role.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TraceEmitter } from '../../src/trace/emitter.js';
import {
  reconstructRecoveryState,
  nextRecoverySequence,
  scanEvents,
} from '../../src/trace/reconcile.js';
import { eventsDir, eventFilename } from '../../src/trace/store.js';

const tmpDirs: string[] = [];
const RUN_ID = '20260521T194720-6752';

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-trace-recov-'));
  tmpDirs.push(dir);
  return path.join(dir, 'trace');
}

function fixedClock(): () => number {
  let t = Date.parse('2026-05-21T19:47:20.000Z');
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

function writeRawEvent(root: string, seq: number, body: Record<string, unknown>): void {
  const dir = eventsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, eventFilename(seq)), JSON.stringify(body), 'utf8');
}

function agentAttempt(seq: number, role: string, attemptNumber: number): Record<string, unknown> {
  return {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
    role,
    attemptNumber,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: 'artifact.json',
    disposition: 'completed',
  };
}

function milestone(seq: number): Record<string, unknown> {
  return {
    sequenceNumber: seq,
    eventType: 'orchestratorMilestone',
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
    milestone: 'tick',
  };
}

describe('recovery sequence continuation', () => {
  it('resumes at N+1 for a trace ending at sequence N (mixed event classes)', () => {
    const root = makeRoot();
    // A trace ending at sequence 5, with a mix of classes.
    writeRawEvent(root, 0, milestone(0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 1));
    writeRawEvent(root, 2, milestone(2));
    writeRawEvent(root, 3, agentAttempt(3, 'gan-evaluator', 1));
    writeRawEvent(root, 4, milestone(4));
    writeRawEvent(root, 5, milestone(5));

    const state = reconstructRecoveryState(root);
    expect(state.nextSequence).toBe(6);
    expect(nextRecoverySequence(root)).toBe(6);
  });

  it('a TraceEmitter constructed with the resume sequence continues without a gap or collision', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, milestone(0));
    writeRawEvent(root, 1, milestone(1));
    writeRawEvent(root, 2, milestone(2));

    const resume = nextRecoverySequence(root);
    expect(resume).toBe(3);

    const emitter = new TraceEmitter(
      { traceRoot: root, runId: RUN_ID, startSequence: resume },
      fixedClock(),
    );
    expect(emitter.peekNextSequence()).toBe(3);

    const ev3 = emitter.emitOrchestratorMilestone({ milestone: 'resumed' });
    const ev4 = emitter.emitOrchestratorMilestone({
      milestone: 'sprintEnd',
      disposition: 'success',
    });
    expect(ev3.sequenceNumber).toBe(3);
    expect(ev4.sequenceNumber).toBe(4);

    // Gapless, no collision: 0..4 all present exactly once.
    const { events } = scanEvents(root);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
  });

  it('an empty / never-started trace resumes at sequence 0', () => {
    const root = makeRoot();
    expect(nextRecoverySequence(root)).toBe(0);
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID, startSequence: 0 });
    expect(emitter.peekNextSequence()).toBe(0);
  });
});

describe('attempt-counter reconstruction (no external counter file)', () => {
  it('reconstructs per-role attempt count and highest attemptNumber from agentAttempt events', () => {
    const root = makeRoot();
    // gan-generator: attempts 1, 2, 3 (count 3, highest 3).
    // gan-evaluator: attempt 1 (count 1, highest 1).
    writeRawEvent(root, 0, milestone(0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 1));
    writeRawEvent(root, 2, agentAttempt(2, 'gan-evaluator', 1));
    writeRawEvent(root, 3, agentAttempt(3, 'gan-generator', 2));
    writeRawEvent(root, 4, agentAttempt(4, 'gan-generator', 3));

    const state = reconstructRecoveryState(root);
    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 3,
      highestAttemptNumber: 3,
    });
    expect(state.attemptStateByRole['gan-evaluator']).toEqual({
      attemptCount: 1,
      highestAttemptNumber: 1,
    });
    // No counter file exists on disk; the state came purely from the events.
    expect(state.nextSequence).toBe(5);
  });

  it('returns an empty per-role map for a trace with no agentAttempt events', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, milestone(0));
    const state = reconstructRecoveryState(root);
    expect(Object.keys(state.attemptStateByRole)).toEqual([]);
  });

  it('reconstructs from a trace produced by the emitter (round-trip)', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { a: 1 },
      outputArtifactPath: 'g.json',
      disposition: 'failed',
    });
    emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 2,
      inputs: { a: 2 },
      outputArtifactPath: 'g.json',
      disposition: 'completed',
    });

    const state = reconstructRecoveryState(root);
    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 2,
      highestAttemptNumber: 2,
    });
    expect(state.nextSequence).toBe(3);
  });
});

describe('web_node_prototype_pollution (recovery fold reuses the guard)', () => {
  it('a malformed adversarial event is dropped by the scan and does not pollute the counter map or Object.prototype', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1));
    // An adversarial archived event carrying a __proto__ key. scanEvents (which
    // reconstructRecoveryState reuses) guards against prototype pollution and
    // classifies the file malformed rather than folding it in.
    const dir = eventsDir(root);
    writeFileSync(
      path.join(dir, eventFilename(1)),
      '{"sequenceNumber": 1, "eventType": "agentAttempt", "__proto__": {"polluted": "yes"}}',
      'utf8',
    );

    const state = reconstructRecoveryState(root);
    // The polluted key never reached any prototype chain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(state.attemptStateByRole)).toBeNull();
    // Only the well-formed attempt was folded in.
    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 1,
      highestAttemptNumber: 1,
    });
    // The malformed file did not contribute a counter for a forbidden key.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((state.attemptStateByRole as any).polluted).toBeUndefined();
  });

  it('the reconstructed counter map is a null-prototype object', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1));
    const state = reconstructRecoveryState(root);
    expect(Object.getPrototypeOf(state.attemptStateByRole)).toBeNull();
  });
});

describe('forward-compat: recovery past an unknown event class', () => {
  function unknownClass(seq: number): Record<string, unknown> {
    return {
      sequenceNumber: seq,
      eventType: 'clarifierFinding',
      timestamp: '2026-05-21T19:47:20.000Z',
      runId: RUN_ID,
      finding: 'recorded by a newer framework version',
    };
  }

  it('resumes past an unknown-class event holding the highest sequence (gapless)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, milestone(0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 1));
    // The trace ends with an event class this v1 reader does not know. It must
    // still count for sequence continuation, or recovery would reuse seq 2.
    writeRawEvent(root, 2, unknownClass(2));

    const state = reconstructRecoveryState(root);
    expect(state.nextSequence).toBe(3);
    expect(nextRecoverySequence(root)).toBe(3);
    // The unknown class is not folded into the known-class attempt counters.
    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 1,
      highestAttemptNumber: 1,
    });

    // A TraceEmitter resuming at the reconstructed sequence continues gaplessly.
    const emitter = new TraceEmitter(
      { traceRoot: root, runId: RUN_ID, startSequence: state.nextSequence },
      fixedClock(),
    );
    const ev = emitter.emitOrchestratorMilestone({ milestone: 'resumed' });
    expect(ev.sequenceNumber).toBe(3);
  });
});

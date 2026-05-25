/**
 * Recovery-state reconstruction suite — proves a `--recover` resume can be
 * driven entirely from the event files, with no external counter/state file.
 *
 * Sequence continuation (gaplessness): for a trace ending at sequence N,
 * reconstructRecoveryState / nextRecoverySequence return N+1, and a TraceEmitter
 * started at that resume point continues with no gap and no collision — the
 * combined on-disk sequence stays a contiguous run. An empty/never-started
 * trace resumes at 0.
 *
 * Attempt-counter reconstruction: per-role attemptCount and highestAttemptNumber
 * are derived purely from the agentAttempt events (no counter file), a trace
 * with none yields an empty per-role map, and an emitter-produced trace
 * round-trips to the same counts.
 *
 * Prototype-pollution guard (recovery reuses the scan's guard): an adversarial
 * `__proto__` event file is dropped by the scan and must not pollute
 * Object.prototype, the counter map, or admit a phantom role; the reconstructed
 * counter map is itself a null-prototype object.
 *
 * Forward-compat: recovery resumes PAST an unknown-class event that holds the
 * highest sequence (the resume point still advances to N+1 gaplessly) while
 * attributing attempt counts only to the known agentAttempt events.
 *
 * writeRawEvent plants event files directly (bypassing the emitter) so tests
 * can construct mixed-class, malformed, and unknown-class traces by hand.
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

    // The pre-existing 0..2 and the resumed 3..4 form one contiguous run —
    // this is the gaplessness invariant a resume must preserve.
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

    // gan-generator attempts three times (seq 1,3,4) interleaved with one
    // gan-evaluator attempt — so per-role counts must be attributed by role,
    // not by total agentAttempt count.
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

    const dir = eventsDir(root);
    writeFileSync(
      path.join(dir, eventFilename(1)),
      '{"sequenceNumber": 1, "eventType": "agentAttempt", "__proto__": {"polluted": "yes"}}',
      'utf8',
    );

    const state = reconstructRecoveryState(root);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(state.attemptStateByRole)).toBeNull();

    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 1,
      highestAttemptNumber: 1,
    });

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
      // A class name no current version enumerates, standing in for an event a
      // future framework version emits; the placeholder must stay outside the
      // known set or this stops testing the unknown-class path.
      eventType: 'futureUnknownEvent',
      timestamp: '2026-05-21T19:47:20.000Z',
      runId: RUN_ID,
      finding: 'recorded by a newer framework version',
    };
  }

  it('resumes past an unknown-class event holding the highest sequence (gapless)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, milestone(0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 1));

    // The highest-sequence event is an unknown class; the resume point must
    // still advance past it (to 3) even though recovery can't interpret it.
    writeRawEvent(root, 2, unknownClass(2));

    const state = reconstructRecoveryState(root);
    expect(state.nextSequence).toBe(3);
    expect(nextRecoverySequence(root)).toBe(3);

    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 1,
      highestAttemptNumber: 1,
    });

    const emitter = new TraceEmitter(
      { traceRoot: root, runId: RUN_ID, startSequence: state.nextSequence },
      fixedClock(),
    );
    const ev = emitter.emitOrchestratorMilestone({ milestone: 'resumed' });
    expect(ev.sequenceNumber).toBe(3);
  });
});

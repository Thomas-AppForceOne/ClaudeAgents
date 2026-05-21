/**
 * T1 Sprint 2 — index reconciliation (F2.6), unrecoverable classification
 * (F2.8), and the prototype-pollution guard.
 *
 * Covers contract criteria:
 *  - index_reconciliation_events_authoritative: lagging index is rebuilt from
 *    the authoritative on-disk events; index fully regenerable.
 *  - unrecoverable_run_classification: malformed-envelope ⇒ unrecoverable;
 *    >1 missing-sequence ⇒ unrecoverable; well-formed + ≤1 missing-sequence ⇒
 *    recoverable.
 *  - prototype_pollution: a parsed event carrying __proto__/constructor/
 *    prototype keys must not pollute Object.prototype or the reconciled index.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TraceEmitter } from '../../src/trace/emitter.js';
import {
  scanEvents,
  buildIndex,
  reconcileIndex,
  isUnrecoverable,
  safeMergeParsedObject,
} from '../../src/trace/reconcile.js';
import { eventsDir, indexPath, eventFilename } from '../../src/trace/store.js';
import { getRunTraceIndexValidator } from '../../src/config-server/validation/schema-check.js';

const tmpDirs: string[] = [];
const RUN_ID = '20260521T194720-6752';

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-trace-rec-'));
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

/** Write a raw event file directly (bypassing the emitter) for fixtures. */
function writeRawEvent(root: string, seq: number, body: string): void {
  const dir = eventsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, eventFilename(seq)), body, 'utf8');
}

function validEvent(seq: number, eventType = 'orchestratorMilestone'): Record<string, unknown> {
  const base = {
    sequenceNumber: seq,
    eventType,
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
  };
  if (eventType === 'orchestratorMilestone') {
    return { ...base, milestone: 'tick' };
  }
  return base;
}

describe('index_reconciliation_events_authoritative', () => {
  it('rebuilds a lagging index to reflect every on-disk event', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { x: 1 },
      outputArtifactPath: 'a.json',
      disposition: 'completed',
    });

    // Simulate a LAGGING index: an index that knows about fewer events than
    // are on disk (as if the process died after the event write but before
    // the index write).
    writeFileSync(
      indexPath(root),
      JSON.stringify({ runId: RUN_ID, totalEvents: 0, countByClass: {} }),
      'utf8',
    );

    const reconciled = reconcileIndex(root, RUN_ID);
    expect(reconciled.totalEvents).toBe(2);
    expect(reconciled.countByClass).toEqual({ orchestratorMilestone: 1, agentAttempt: 1 });

    // The persisted index validates against the Sprint-1 index schema.
    const onDisk = JSON.parse(readFileSync(indexPath(root), 'utf8'));
    const validate = getRunTraceIndexValidator();
    expect(validate(onDisk), JSON.stringify(validate.errors)).toBe(true);
  });

  it('events win when the index disagrees (extra on-disk events override a stale count)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(validEvent(1, 'orchestratorMilestone')));
    writeRawEvent(root, 2, JSON.stringify(validEvent(2, 'orchestratorMilestone')));
    // A stale index claiming only one event of the wrong class.
    writeFileSync(
      indexPath(root),
      JSON.stringify({ runId: RUN_ID, totalEvents: 1, countByClass: { llmCall: 1 } }),
      'utf8',
    );
    const reconciled = reconcileIndex(root, RUN_ID);
    expect(reconciled.totalEvents).toBe(3);
    expect(reconciled.countByClass).toEqual({ orchestratorMilestone: 3 });
  });

  it('the index is fully regenerable from the event files alone (delete + regenerate ⇒ equivalent)', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    emitter.emitLlmCall({
      role: 'gan-generator',
      request: {
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        messageHistory: [],
        toolDefinitions: [],
      },
      payloads: { prompt: 'p', response: 'r' },
      tokensInput: 1,
      tokensCached: 0,
      tokensOutput: 1,
      latencyMs: 1,
      cacheHit: false,
    });
    emitter.emitOrchestratorMilestone({ milestone: 'sprintEnd', disposition: 'success' });

    const before = JSON.parse(readFileSync(indexPath(root), 'utf8'));
    // Delete the index entirely; regenerate purely from the events.
    rmSync(indexPath(root));
    expect(existsSync(indexPath(root))).toBe(false);
    const regenerated = reconcileIndex(root, RUN_ID);
    expect(regenerated).toEqual(before);
    // The terminal disposition is recovered from the events.
    expect(regenerated.disposition).toBe('success');
  });

  it('buildIndex derives counts/timestamps/disposition purely from events', () => {
    const events = scanEvents(makeRoot()).events; // empty dir
    const idx = buildIndex(RUN_ID, events);
    expect(idx).toEqual({ runId: RUN_ID, totalEvents: 0, countByClass: {} });
  });
});

describe('unrecoverable_run_classification', () => {
  it('classifies a malformed-envelope run as unrecoverable (predicate a)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0)));
    // A malformed envelope: missing eventType (schema-invalid).
    writeRawEvent(
      root,
      1,
      JSON.stringify({ sequenceNumber: 1, timestamp: '2026-05-21T19:47:20.000Z', runId: RUN_ID }),
    );
    expect(isUnrecoverable(root)).toBe(true);
  });

  it('classifies a >1 missing-sequence run as unrecoverable (predicate b)', () => {
    const root = makeRoot();
    // Two files lacking a readable sequence number. They must still be valid
    // envelopes otherwise (so predicate (a) is not what fires) — but a missing
    // sequenceNumber also fails the schema, so to isolate predicate (b) we use
    // files that parse but carry no integer sequenceNumber.
    writeRawEvent(root, 0, JSON.stringify({ note: 'no sequence here', eventType: 'x' }));
    writeRawEvent(root, 1, JSON.stringify({ note: 'also none', eventType: 'y' }));
    expect(isUnrecoverable(root)).toBe(true);
  });

  it('classifies a well-formed run with at most one missing-sequence file as recoverable', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0)));
    writeRawEvent(root, 1, JSON.stringify(validEvent(1, 'orchestratorMilestone')));
    expect(isUnrecoverable(root)).toBe(false);
  });

  it('an empty / never-started run is recoverable (no malformed, no missing-seq)', () => {
    expect(isUnrecoverable(makeRoot())).toBe(false);
  });

  it('a run produced entirely by the emitter is recoverable', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    emitter.emitOrchestratorMilestone({ milestone: 'sprintEnd', disposition: 'success' });
    expect(isUnrecoverable(root)).toBe(false);
  });
});

describe('prototype_pollution guard', () => {
  it('safeMergeParsedObject rejects a __proto__ key', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "eventType": "x"}');
    expect(() => safeMergeParsedObject(parsed)).toThrow();
  });

  it('safeMergeParsedObject rejects constructor / prototype keys', () => {
    expect(() => safeMergeParsedObject({ constructor: {} } as Record<string, unknown>)).toThrow();
    expect(() => safeMergeParsedObject({ prototype: {} } as Record<string, unknown>)).toThrow();
  });

  it('reconciliation does not pollute Object.prototype from an adversarial event file', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0)));
    // An adversarial event file whose parsed object carries a __proto__ key.
    writeRawEvent(
      root,
      1,
      '{"sequenceNumber": 1, "eventType": "x", "__proto__": {"polluted": "yes"}}',
    );

    // Scanning treats the adversarial file as malformed (guard fired) rather
    // than folding it in, and Object.prototype is untouched.
    const { events, malformedEnvelopeCount } = scanEvents(root);
    expect(malformedEnvelopeCount).toBeGreaterThanOrEqual(1);
    // The polluted key never reached any object's prototype.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    // Only the well-formed event survived.
    expect(events.map((e) => e.sequenceNumber)).toEqual([0]);
    // And the run is classified unrecoverable because a file was malformed.
    expect(isUnrecoverable(root)).toBe(true);
  });

  it('safeMergeParsedObject returns a null-prototype copy of safe keys', () => {
    const out = safeMergeParsedObject({ a: 1, b: 'two' });
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(out.a).toBe(1);
    expect(out.b).toBe('two');
  });
});

describe('forward-compat: unknown event-class types (T1 reader invariant)', () => {
  function unknownClassEvent(seq: number, eventType: string): Record<string, unknown> {
    return {
      sequenceNumber: seq,
      eventType,
      timestamp: '2026-05-21T19:47:20.000Z',
      runId: RUN_ID,
      // a class-specific field a v1 reader does not know how to interpret:
      finding: 'something a newer framework version recorded',
    };
  }

  it('skips an unknown-but-well-formed event class without marking it malformed (run stays recoverable)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(unknownClassEvent(1, 'clarifierFinding')));

    const scan = scanEvents(root);
    // Neither malformed nor missing-sequence → the run stays recoverable.
    expect(scan.malformedEnvelopeCount).toBe(0);
    expect(scan.missingSequenceCount).toBe(0);
    expect(isUnrecoverable(root)).toBe(false);
    // The known event is in `events`; the unknown class is bucketed separately.
    expect(scan.events.map((e) => e.sequenceNumber)).toEqual([0]);
    expect(scan.unknownClassEvents).toEqual([
      { sequenceNumber: 1, eventType: 'clarifierFinding', timestamp: '2026-05-21T19:47:20.000Z' },
    ]);
    // A structured warning was emitted naming the class and the sequence.
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('clarifierFinding');
    expect(scan.warnings[0]).toContain('1');
  });

  it('counts unknown-class events in the reconciled index (totalEvents + countByClass)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(unknownClassEvent(1, 'clarifierFinding')));
    writeRawEvent(root, 2, JSON.stringify(unknownClassEvent(2, 'clarifierFinding')));

    const index = reconcileIndex(root, RUN_ID);
    expect(index.totalEvents).toBe(3);
    expect(index.countByClass).toEqual({ orchestratorMilestone: 1, clarifierFinding: 2 });
    // The persisted index still validates against the Sprint-1 index schema.
    const validate = getRunTraceIndexValidator();
    expect(validate(index), JSON.stringify(validate.errors)).toBe(true);
  });

  it('treats an unknown class with a malformed envelope as malformed (not tolerated)', () => {
    const root = makeRoot();
    // Unknown eventType but missing runId → the envelope is not well-formed.
    writeRawEvent(
      root,
      0,
      JSON.stringify({
        sequenceNumber: 0,
        eventType: 'clarifierFinding',
        timestamp: '2026-05-21T19:47:20.000Z',
      }),
    );
    const scan = scanEvents(root);
    expect(scan.unknownClassEvents).toEqual([]);
    expect(scan.malformedEnvelopeCount).toBe(1);
    expect(isUnrecoverable(root)).toBe(true);
  });

  it('does not tolerate a forbidden-key eventType value (prototype-pollution vector)', () => {
    const root = makeRoot();
    writeRawEvent(
      root,
      0,
      JSON.stringify({
        sequenceNumber: 0,
        eventType: '__proto__',
        timestamp: '2026-05-21T19:47:20.000Z',
        runId: RUN_ID,
      }),
    );
    const scan = scanEvents(root);
    // Not bucketed as a tolerated unknown class; falls through to malformed.
    expect(scan.unknownClassEvents).toEqual([]);
    expect(scan.malformedEnvelopeCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });
});

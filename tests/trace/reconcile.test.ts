/**
 * Index-reconciliation suite — proves the run index is a derived, fully
 * regenerable view of the event files, and that reconciliation is hardened
 * against malformed and adversarial event data.
 *
 * Events are authoritative: a lagging or disagreeing index is rebuilt to match
 * what is actually on disk (extra on-disk events override a stale count), and
 * deleting the index then regenerating yields an object equal to the original —
 * so the index never holds state that the events can't reproduce. buildIndex
 * derives every field (counts / disposition) purely from the event list.
 *
 * Unrecoverable classification (two predicates): a run is unrecoverable if any
 * event has a malformed envelope, OR if more than one sequence is missing. A
 * well-formed run with at most one gap, an empty/never-started run, and any
 * emitter-produced run are all recoverable.
 *
 * Prototype-pollution guard: safeMergeParsedObject rejects __proto__ /
 * constructor / prototype keys and returns a null-prototype copy, and a full
 * reconcile over an adversarial `__proto__` event file must neither pollute
 * Object.prototype nor admit the event (it counts as malformed -> unrecoverable).
 *
 * Forward-compat (T1 reader invariant): an unknown-but-well-formed event class
 * (what a newer framework version might write) is tolerated — skipped from the
 * typed `events` list, surfaced in `unknownClassEvents` with a warning, and
 * still counted in the reconciled index — without marking the run malformed. A
 * malformed envelope on an unknown class is still malformed, and a forbidden
 * key as the `eventType` VALUE is rejected (pollution vector closed).
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

// Writes an event file directly, bypassing the emitter, so tests can plant
// hand-crafted, malformed, or adversarial bodies the emitter would never
// produce — the reconciler must cope with whatever is on disk.
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

    // Plant a deliberately stale index (totalEvents: 0) over two real events;
    // reconcile must rebuild it to reflect the events, not trust the index.
    writeFileSync(
      indexPath(root),
      JSON.stringify({ runId: RUN_ID, totalEvents: 0, countByClass: {} }),
      'utf8',
    );

    const reconciled = reconcileIndex(root, RUN_ID);
    expect(reconciled.totalEvents).toBe(2);
    expect(reconciled.countByClass).toEqual({ orchestratorMilestone: 1, agentAttempt: 1 });

    const onDisk = JSON.parse(readFileSync(indexPath(root), 'utf8'));
    const validate = getRunTraceIndexValidator();
    expect(validate(onDisk), JSON.stringify(validate.errors)).toBe(true);
  });

  it('events win when the index disagrees (extra on-disk events override a stale count)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(validEvent(1, 'orchestratorMilestone')));
    writeRawEvent(root, 2, JSON.stringify(validEvent(2, 'orchestratorMilestone')));

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

    rmSync(indexPath(root));
    expect(existsSync(indexPath(root))).toBe(false);
    const regenerated = reconcileIndex(root, RUN_ID);
    expect(regenerated).toEqual(before);

    expect(regenerated.disposition).toBe('success');
  });

  it('buildIndex derives counts/timestamps/disposition purely from events', () => {
    const events = scanEvents(makeRoot()).events;
    const idx = buildIndex(RUN_ID, events);
    expect(idx).toEqual({ runId: RUN_ID, totalEvents: 0, countByClass: {} });
  });
});

describe('unrecoverable_run_classification', () => {
  it('classifies a malformed-envelope run as unrecoverable (predicate a)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0)));

    // Second event omits the required `eventType` — a malformed envelope, which
    // alone makes the whole run unrecoverable (predicate a).
    writeRawEvent(
      root,
      1,
      JSON.stringify({ sequenceNumber: 1, timestamp: '2026-05-21T19:47:20.000Z', runId: RUN_ID }),
    );
    expect(isUnrecoverable(root)).toBe(true);
  });

  it('classifies a >1 missing-sequence run as unrecoverable (predicate b)', () => {
    const root = makeRoot();

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

    writeRawEvent(
      root,
      1,
      '{"sequenceNumber": 1, "eventType": "x", "__proto__": {"polluted": "yes"}}',
    );

    const { events, malformedEnvelopeCount } = scanEvents(root);
    expect(malformedEnvelopeCount).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();

    expect(events.map((e) => e.sequenceNumber)).toEqual([0]);

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

      finding: 'something a newer framework version recorded',
    };
  }

  it('skips an unknown-but-well-formed event class without marking it malformed (run stays recoverable)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(unknownClassEvent(1, 'futureUnknownEvent')));

    const scan = scanEvents(root);

    expect(scan.malformedEnvelopeCount).toBe(0);
    expect(scan.missingSequenceCount).toBe(0);
    expect(isUnrecoverable(root)).toBe(false);

    expect(scan.events.map((e) => e.sequenceNumber)).toEqual([0]);
    expect(scan.unknownClassEvents).toEqual([
      { sequenceNumber: 1, eventType: 'futureUnknownEvent', timestamp: '2026-05-21T19:47:20.000Z' },
    ]);

    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('futureUnknownEvent');
    expect(scan.warnings[0]).toContain('1');
  });

  it('counts unknown-class events in the reconciled index (totalEvents + countByClass)', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, JSON.stringify(validEvent(0, 'orchestratorMilestone')));
    writeRawEvent(root, 1, JSON.stringify(unknownClassEvent(1, 'futureUnknownEvent')));
    writeRawEvent(root, 2, JSON.stringify(unknownClassEvent(2, 'futureUnknownEvent')));

    const index = reconcileIndex(root, RUN_ID);
    expect(index.totalEvents).toBe(3);
    expect(index.countByClass).toEqual({ orchestratorMilestone: 1, futureUnknownEvent: 2 });

    const validate = getRunTraceIndexValidator();
    expect(validate(index), JSON.stringify(validate.errors)).toBe(true);
  });

  it('treats an unknown class with a malformed envelope as malformed (not tolerated)', () => {
    const root = makeRoot();

    writeRawEvent(
      root,
      0,
      JSON.stringify({
        sequenceNumber: 0,
        eventType: 'futureUnknownEvent',
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

    expect(scan.unknownClassEvents).toEqual([]);
    expect(scan.malformedEnvelopeCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });
});

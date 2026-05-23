/**
 * TraceEmitter contract suite — proves the emission surface upholds the
 * append-only run-trace invariants the recovery/reconcile layers depend on.
 *
 * What this guards (one assertion family per describe block):
 * - schema conformance: every one of the seven event classes the emitter can
 *   produce validates against run-trace-v1.json, both as the in-memory object
 *   and after round-tripping through the atomic on-disk write.
 * - sequence allocation: numbers are strictly increasing, gapless, and
 *   non-negative across mixed classes, and a non-zero `startSequence` resumes
 *   without a gap or collision — the property recovery relies on to continue
 *   an interrupted run.
 * - payload layout: payload files land under `payloads/` with a 10-digit
 *   zero-padded sequence prefix, an allowed payload class suffix, and the
 *   extension implied by the payload kind (.md for text, .json for arguments),
 *   never an absolute or backslashed path.
 * - redaction: `full` writes payload bodies to disk while `hashed` writes
 *   none, yet BOTH record the same content-hash refs — so a redacted trace is
 *   still verifiable by hash. Full is the default when redaction is unset.
 * - append-only: the emitter exposes no update/overwrite/delete method, and a
 *   re-emitted "correction" produces an ADDITIONAL event file (superseding by
 *   appending), never an in-place mutation of the prior event's bytes.
 *
 * A fixed clock and per-test temp roots keep every assertion deterministic and
 * hermetic; the afterEach reaps the temp dirs.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TraceEmitter } from '../../src/trace/emitter.js';
import type { LlmCallInput, ToolCallInput } from '../../src/trace/emitter.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';
import { eventsDir, payloadsDir } from '../../src/trace/store.js';
import { KNOWN_EVENT_TYPES } from '../../src/trace/events.js';

const tmpDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-trace-'));
  tmpDirs.push(dir);
  return path.join(dir, 'trace');
}

// Monotonic +1ms-per-tick clock: removes wall-clock nondeterminism so
// timestamps are reproducible, and guarantees each event gets a distinct,
// strictly-increasing instant (the emitter still treats sequenceNumber, not
// the clock, as the authoritative order).
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

const RUN_ID = '20260521T194720-6752';

function llmInput(): LlmCallInput {
  return {
    role: 'gan-generator',
    request: {
      model: 'claude-opus-4',
      systemPrompt: 'sys',
      userPrompt: 'user',
      messageHistory: [{ role: 'user', content: 'hi' }],
      toolDefinitions: [{ name: 'Read' }],
    },
    payloads: { prompt: 'the prompt text', response: 'the response text' },
    tokensInput: 1200,
    tokensCached: 800,
    tokensOutput: 350,
    latencyMs: 4200,
    cacheHit: true,
  };
}

function toolInput(): ToolCallInput {
  return {
    tool: 'Read',
    role: 'gan-generator',
    payloads: { arguments: { file: 'x.ts' }, result: 'file contents' },
    disposition: 'completed',
    latencyMs: 18,
  };
}

// Emits exactly one event of each of the seven known classes, in a fixed
// order, so a single fixture can drive both the "all classes validate" and
// "sequence is gapless across mixed classes" checks.
function emitOneOfEach(emitter: TraceEmitter) {
  const events = [
    emitter.emitOrchestratorMilestone({
      milestone: 'sprintStart',
      summary: 'Sprint 2 begins.',
    }),
    emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { contract: 'sprint-2' },
      outputArtifactPath: 'sprint-2-output.json',
      disposition: 'completed',
    }),
    emitter.emitLlmCall(llmInput()),
    emitter.emitToolCall(toolInput()),
    emitter.emitSafetyHalt({
      safetyClass: 'loopDetected',
      role: 'gan-orchestrator',
      payload: { reason: 'noProgress', attempts: 3 },
    }),
    emitter.emitTrustEvent({
      promptVariant: 'initialIntroduction',
      userChoice: 'approve',
      contentHash: 'd'.repeat(64),
    }),
    emitter.emitValidationAbort({
      validationStage: 'overlay',
      errorCode: 'UntrustedOverlay',
      errorPayload: { code: 'UntrustedOverlay', message: 'not trusted' },
    }),
  ];
  return events;
}

describe('event_validates_against_schema — all seven classes', () => {
  it('every constructed event validates against run-trace-v1.json via getRunTraceValidator', () => {
    const emitter = new TraceEmitter({ traceRoot: makeRoot(), runId: RUN_ID }, fixedClock());
    const validate = getRunTraceValidator();
    const events = emitOneOfEach(emitter);

    // Asserting the produced set equals KNOWN_EVENT_TYPES is what makes this a
    // completeness check: if a new event class is added without a fixture here,
    // this fails rather than silently skipping the new class.
    const seen = new Set(events.map((e) => e.eventType));
    expect(seen).toEqual(KNOWN_EVENT_TYPES);

    for (const event of events) {
      const ok = validate(event);
      expect(ok, `${event.eventType}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('the on-disk event files also validate (round-trip through atomicWriteFile)', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitOneOfEach(emitter);
    const validate = getRunTraceValidator();
    const files = readdirSync(eventsDir(root)).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(7);
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(path.join(eventsDir(root), f), 'utf8'));
      expect(validate(parsed), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

describe('sequence_monotonic_gapless', () => {
  it('allocates strictly increasing, gapless, non-negative sequence numbers across mixed classes', () => {
    const emitter = new TraceEmitter({ traceRoot: makeRoot(), runId: RUN_ID }, fixedClock());
    const events = emitOneOfEach(emitter);
    const seqs = events.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < seqs.length; i += 1) {
      expect(Number.isInteger(seqs[i])).toBe(true);
      expect(seqs[i]).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(seqs[i] - seqs[i - 1]).toBe(1);
    }
  });

  it('honours a non-zero startSequence and continues gaplessly (recovery resumption)', () => {
    const emitter = new TraceEmitter(
      { traceRoot: makeRoot(), runId: RUN_ID, startSequence: 100 },
      fixedClock(),
    );
    const a = emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    const b = emitter.emitOrchestratorMilestone({ milestone: 'roleTransition' });
    expect(a.sequenceNumber).toBe(100);
    expect(b.sequenceNumber).toBe(101);
    expect(emitter.peekNextSequence()).toBe(102);
  });
});

describe('payload_naming_and_layout', () => {
  it('writes payloads under payloads/ with 10-digit zero-pad, allowed class, and ext-by-type', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());

    // Burn 42 sequence numbers so the next event lands at seq 42 — a
    // two-digit value chosen to exercise the 10-digit zero-pad in the filename.
    for (let i = 0; i < 42; i += 1) emitter.emitOrchestratorMilestone({ milestone: 'tick' });
    const tool = emitter.emitToolCall(toolInput());
    expect(tool.sequenceNumber).toBe(42);

    // arguments are structured (.json), result is free text (.md) — extension
    // is chosen by payload kind, not a fixed default.
    expect(tool.argumentsRef).toBe('payloads/0000000042-gan-generator-arguments.json');
    expect(tool.resultRef).toBe('payloads/0000000042-gan-generator-result.md');

    for (const ref of [tool.argumentsRef, tool.resultRef]) {
      expect(ref.startsWith('/')).toBe(false);
      expect(ref.includes('\\')).toBe(false);
      expect(ref.split('/')[0]).toBe('payloads');
      const cls = ref.split('-').slice(-1)[0].split('.')[0];
      expect(['prompt', 'response', 'arguments', 'result']).toContain(cls);
    }

    const names = readdirSync(payloadsDir(root)).sort();
    expect(names).toEqual([
      '0000000042-gan-generator-arguments.json',
      '0000000042-gan-generator-result.md',
    ]);
  });

  it('stores llmCall prompt/response as .md text payloads named by sequence', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    const call = emitter.emitLlmCall(llmInput());
    expect(call.sequenceNumber).toBe(0);
    const names = readdirSync(payloadsDir(root)).sort();
    expect(names).toEqual([
      '0000000000-gan-generator-prompt.md',
      '0000000000-gan-generator-response.md',
    ]);
    expect(readFileSync(path.join(payloadsDir(root), names[0]), 'utf8')).toBe('the prompt text');
    expect(readFileSync(path.join(payloadsDir(root), names[1]), 'utf8')).toBe('the response text');
  });
});

describe('redaction_hashed_writes_no_payloads', () => {
  it('full mode writes payload content; hashed mode writes none but keeps hashes', () => {

    const fullRoot = makeRoot();
    const full = new TraceEmitter(
      { traceRoot: fullRoot, runId: RUN_ID, redaction: 'full' },
      fixedClock(),
    );
    const fullLlm = full.emitLlmCall(llmInput());
    const fullTool = full.emitToolCall(toolInput());
    expect(readdirSync(payloadsDir(fullRoot)).length).toBe(4);
    expect(fullLlm.promptRef).toMatch(/^[0-9a-f]{64}$/);
    expect(fullLlm.responseRef).toMatch(/^[0-9a-f]{64}$/);

    const hashedRoot = makeRoot();
    const hashed = new TraceEmitter(
      { traceRoot: hashedRoot, runId: RUN_ID, redaction: 'hashed' },
      fixedClock(),
    );
    const hashedLlm = hashed.emitLlmCall(llmInput());
    const hashedTool = hashed.emitToolCall(toolInput());

    // Hashed mode may never create the payloads dir at all; tolerate either
    // absent-dir or empty-dir, but forbid any actual payload file.
    const payloadDirExists = existsSync(payloadsDir(hashedRoot));
    if (payloadDirExists) {
      expect(readdirSync(payloadsDir(hashedRoot))).toEqual([]);
    }

    expect(hashedLlm.promptRef).toMatch(/^[0-9a-f]{64}$/);
    expect(hashedLlm.responseRef).toMatch(/^[0-9a-f]{64}$/);

    // The key redaction invariant: the ref is the SAME hash whether or not the
    // body was written, so a hashed trace remains verifiable against a body
    // produced elsewhere.
    expect(hashedLlm.promptRef).toBe(fullLlm.promptRef);

    expect(hashedTool.argumentsRef).toBe(fullTool.argumentsRef);
    expect(hashedTool.resultRef).toBe(fullTool.resultRef);
  });

  it('defaults to full mode when no redaction is supplied', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    expect(emitter.getRedactionMode()).toBe('full');
    emitter.emitLlmCall(llmInput());
    expect(readdirSync(payloadsDir(root)).length).toBe(2);
  });
});

describe('append_only_superseding_corrections', () => {
  it('exposes no update/overwrite/delete entry point on the emission surface', () => {
    const emitter = new TraceEmitter({ traceRoot: makeRoot(), runId: RUN_ID }, fixedClock());
    const surface = emitter as unknown as Record<string, unknown>;
    // Enforce append-only structurally, by inspecting the prototype's method
    // names rather than behaviour: any method whose name implies mutation is a
    // contract violation regardless of what it does.
    const proto = Object.getPrototypeOf(emitter);
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && typeof (proto as Record<string, unknown>)[n] === 'function',
    );
    const forbidden = /^(update|overwrite|delete|remove|mutate|replace|edit|rewrite)/i;
    for (const m of methods) {
      expect(forbidden.test(m), `unexpected mutation method '${m}'`).toBe(false);
    }

    expect(typeof surface.emitOrchestratorMilestone).toBe('function');
  });

  it('a re-emitted correction produces an ADDITIONAL event file, not a mutation of the prior one', () => {
    const root = makeRoot();
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    const first = emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 1,
      inputs: { x: 1 },
      outputArtifactPath: 'a.json',
      disposition: 'failed',
    });
    // Capture the first event's exact bytes so we can prove the correction
    // below leaves them untouched (no in-place rewrite).
    const firstFile = path.join(eventsDir(root), `${'0'.repeat(9)}0.json`);
    const firstBytes = readFileSync(firstFile, 'utf8');

    const correction = emitter.emitAgentAttempt({
      role: 'gan-generator',
      attemptNumber: 2,
      inputs: { x: 1 },
      outputArtifactPath: 'a.json',
      disposition: 'completed',
    });

    expect(correction.sequenceNumber).toBe(first.sequenceNumber + 1);

    expect(readFileSync(firstFile, 'utf8')).toBe(firstBytes);

    const files = readdirSync(eventsDir(root)).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(2);
  });
});

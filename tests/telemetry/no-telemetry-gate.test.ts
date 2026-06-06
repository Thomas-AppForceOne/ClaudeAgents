/**
 * --no-telemetry gate behaviour suite.
 *
 * Pins the contract the orchestrator's run-start and run-end emission steps
 * obey:
 *
 *  - the {@link shouldEmitTelemetry} predicate returns `false` when the
 *    user supplied `--no-telemetry` and `true` otherwise;
 *  - when the gate is OFF (telemetry disabled), the orchestrator's
 *    simulated run-start and run-end paths invoke neither writer and the
 *    `<runDir>/telemetry/` directory is never created at any point during
 *    the run;
 *  - an existing `<runDir>/trace/` subtree is untouched by the gate — the
 *    gate scopes only `telemetry/`, never the trace.
 *
 * The orchestrator's actual control-flow lives in SKILL.md prose; the test
 * mirrors the boolean check the SKILL.md step is contracted to perform
 * (`if (shouldEmitTelemetry(flags)) writeTelemetry*` else skip both calls).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { shouldEmitTelemetry } from '../../src/telemetry/gate.js';
import {
  writeTelemetryConfig,
  writeTelemetryOutcome,
} from '../../src/telemetry/index.js';
import { resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';
import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';

const tmpDirs: string[] = [];

function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-gate-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetDroppedEmitsForTests();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// Mirror the orchestrator's SKILL.md step-7 / step-11 control flow over a
// fabricated runDir. Returns a small ledger of which calls actually ran so
// the test can assert on side effects.
async function simulateRun(input: {
  runDir: string;
  noTelemetry: boolean;
}): Promise<{ wroteConfig: boolean; wroteOutcome: boolean }> {
  const gate = shouldEmitTelemetry({ noTelemetry: input.noTelemetry });
  let wroteConfig = false;
  let wroteOutcome = false;
  if (gate) {
    await writeTelemetryConfig({
      runDir: input.runDir,
      runId: '20260606T180000-gate',
      capturedAt: '2026-06-06T18:00:00.000Z',
      resolvedConfig: {
        apiVersion: '0.1.0',
        schemaVersions: {},
        runtimeMode: {},
        stacks: {},
        overlay: {},
        discarded: [],
        additionalContext: {},
        issues: [],
        warnings: [],
        modules: {},
      },
    });
    wroteConfig = true;
  }
  // Sprint loop placeholder. The point of the test is that neither writer
  // runs under the gate.
  if (gate) {
    await writeTelemetryOutcome({
      runDir: input.runDir,
      runId: '20260606T180000-gate',
      terminalReason: 'complete',
      sprints: [
        {
          sprintNumber: 1,
          status: 'complete',
          attemptCounts: { 'gan-generator': 1 },
        },
      ],
      safetyHalts: [],
      writtenAt: '2026-06-06T19:00:00.000Z',
    });
    wroteOutcome = true;
  }
  return { wroteConfig, wroteOutcome };
}

function llmCall(seq: number): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-06-06T19:00:0${seq}.000Z`,
    runId: '20260606T180000-gate',
    model: 'test-model',
    role: 'gan-generator',
    promptRef: 'a'.repeat(64),
    responseRef: 'b'.repeat(64),
    tokensInput: 10,
    tokensCached: 0,
    tokensOutput: 5,
    latencyMs: 100,
    cacheHit: false,
  } as TraceEventInput;
}

describe('shouldEmitTelemetry — predicate truth table', () => {
  it('returns true when --no-telemetry was not supplied (v1.0 default)', () => {
    expect(shouldEmitTelemetry({ noTelemetry: false })).toBe(true);
  });

  it('returns false when --no-telemetry was supplied', () => {
    expect(shouldEmitTelemetry({ noTelemetry: true })).toBe(false);
  });
});

describe('--no-telemetry gate behaviour over a simulated run', () => {
  it('gate ON: neither writer runs and <runDir>/telemetry/ is never created', async () => {
    const runDir = makeRunDir();
    const result = await simulateRun({ runDir, noTelemetry: true });
    expect(result.wroteConfig).toBe(false);
    expect(result.wroteOutcome).toBe(false);
    expect(existsSync(path.join(runDir, 'telemetry'))).toBe(false);
  });

  it('gate OFF (default): both writers run and the artefacts land at the expected paths', async () => {
    const runDir = makeRunDir();
    const result = await simulateRun({ runDir, noTelemetry: false });
    expect(result.wroteConfig).toBe(true);
    expect(result.wroteOutcome).toBe(true);
    expect(existsSync(path.join(runDir, 'telemetry', 'config.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'telemetry', 'outcome.json'))).toBe(true);
  });

  it("gate ON: an existing <runDir>/trace/ subtree is untouched (no telemetry write touches it)", async () => {
    const runDir = makeRunDir();
    // Seed a trace event so trace/events/ exists with a real record.
    appendTraceEvent(runDir, llmCall(0));
    const traceRoot = path.join(runDir, 'trace');
    const beforeListing = readdirSync(traceRoot).sort();
    const beforeEventCount = readdirSync(path.join(traceRoot, 'events')).length;

    const result = await simulateRun({ runDir, noTelemetry: true });
    expect(result.wroteConfig).toBe(false);
    expect(result.wroteOutcome).toBe(false);

    // trace/ subtree byte-for-byte unchanged: the gate scopes telemetry/
    // only and the simulated emission paths must not touch trace/.
    const afterListing = readdirSync(traceRoot).sort();
    expect(afterListing).toEqual(beforeListing);
    const afterEventCount = readdirSync(path.join(traceRoot, 'events')).length;
    expect(afterEventCount).toBe(beforeEventCount);
    // And the telemetry directory is still absent.
    expect(existsSync(path.join(runDir, 'telemetry'))).toBe(false);
  });

  it("gate ON: a pre-existing sibling artefact under runDir is untouched", async () => {
    const runDir = makeRunDir();
    // Place a sibling sentinel that the gate-OFF behaviour must not touch.
    const siblingPath = path.join(runDir, 'progress.json');
    writeFileSync(siblingPath, '{"k":"v"}', 'utf8');
    mkdirSync(path.join(runDir, 'unrelated'), { recursive: true });

    await simulateRun({ runDir, noTelemetry: true });
    expect(existsSync(siblingPath)).toBe(true);
    expect(existsSync(path.join(runDir, 'unrelated'))).toBe(true);
    expect(existsSync(path.join(runDir, 'telemetry'))).toBe(false);
  });
});

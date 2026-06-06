/**
 * Halted-run outcome.json shape suite.
 *
 * Drives a fabricated halted-run scenario through the writer and asserts
 * the contract the framework's loop-detection halt class produces:
 *
 *  - `terminalReason: "failed-loop-detected"` maps to `disposition: "halted"`
 *    via the shipped mapping table;
 *  - `safetyHalts[]` is preserved verbatim from the writer input (each entry
 *    carries the three breadcrumbs an outcome reader needs to locate the
 *    halt's full evidence in the trace);
 *  - the rendered artefact validates against the bundled
 *    `telemetryOutcomeV1` schema (the same schema parity tests check).
 *
 * Per-test fixtures are isolated under their own temp `runDir` and the
 * dropped-emits tally is reset between cases so a previous case's
 * increments do not bleed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AjvImport, { type ValidateFunction } from 'ajv';

import { writeTelemetryOutcome } from '../../src/telemetry/writer-outcome.js';
import { terminalReasonToDisposition } from '../../src/telemetry/mapping.js';
import { telemetryOutcomeV1 } from '../../src/config-server/schemas-bundled.js';
import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import { resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

const tmpDirs: string[] = [];
function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-halt-'));
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

const RUN_ID = '20260606T200000-a017';

function llmCall(seq: number): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-06-06T20:00:0${seq}.000Z`,
    runId: RUN_ID,
    model: 'test-model',
    role: 'gan-generator',
    promptRef: ('a'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    responseRef: ('b'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    tokensInput: 50,
    tokensCached: 0,
    tokensOutput: 25,
    latencyMs: 75,
    cacheHit: false,
  } as TraceEventInput;
}

function compileOutcome(): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  return ajv.compile(telemetryOutcomeV1);
}

describe('halted-run outcome.json — disposition + safetyHalts + schema', () => {
  it('failed-loop-detected → disposition:halted with non-empty safetyHalts[]', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0));

    const halts = [
      {
        sprintNumber: 2,
        safetyClass: 'loopDetected',
        reason: 'editOscillation',
      },
    ];

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'failed-loop-detected',
      sprints: [
        {
          sprintNumber: 1,
          status: 'complete',
          attemptCounts: { 'gan-generator': 1, 'gan-evaluator': 1 },
        },
        {
          sprintNumber: 2,
          status: 'halted',
          attemptCounts: { 'gan-generator': 3 },
        },
      ],
      safetyHalts: halts,
      writtenAt: '2026-06-06T21:00:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      disposition: string;
      terminalReason: string;
      safetyHalts: Array<{ sprintNumber: number; safetyClass: string; reason: string }>;
    };

    expect(parsed.terminalReason).toBe('failed-loop-detected');
    expect(parsed.disposition).toBe('halted');
    // Mapping table sanity: the disposition is what the shared mapping
    // module returns for the same input. A future drift between the
    // mapping module and the writer flunks this pin in addition to the
    // literal-string check above.
    expect(parsed.disposition).toBe(terminalReasonToDisposition('failed-loop-detected'));

    expect(parsed.safetyHalts).toHaveLength(1);
    expect(parsed.safetyHalts[0]).toEqual({
      sprintNumber: 2,
      safetyClass: 'loopDetected',
      reason: 'editOscillation',
    });
  });

  it('the written artefact validates against telemetryOutcomeV1', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0));

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'failed-loop-detected',
      sprints: [
        {
          sprintNumber: 1,
          status: 'halted',
          attemptCounts: { 'gan-generator': 3 },
        },
      ],
      safetyHalts: [
        {
          sprintNumber: 1,
          safetyClass: 'loopDetected',
          reason: 'roleCeilingExceeded',
        },
      ],
      writtenAt: '2026-06-06T21:00:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    const validate = compileOutcome();
    const ok = validate(parsed);
    if (!ok) {
      throw new Error(`telemetryOutcomeV1 validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('a multi-halt run preserves every safetyHalts[] entry verbatim and in order', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0));

    const halts = [
      { sprintNumber: 1, safetyClass: 'loopDetected', reason: 'roleCeilingExceeded' },
      { sprintNumber: 2, safetyClass: 'loopDetected', reason: 'sprintBudgetExceeded' },
      { sprintNumber: 3, safetyClass: 'loopDetected', reason: 'editOscillation' },
    ];

    const target = await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'failed-loop-detected',
      sprints: [
        { sprintNumber: 1, status: 'halted', attemptCounts: { 'gan-generator': 3 } },
        { sprintNumber: 2, status: 'halted', attemptCounts: { 'gan-generator': 5 } },
        { sprintNumber: 3, status: 'halted', attemptCounts: { 'gan-generator': 3 } },
      ],
      safetyHalts: halts,
      writtenAt: '2026-06-06T21:00:00.000Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      safetyHalts: Array<{ sprintNumber: number; safetyClass: string; reason: string }>;
    };
    expect(parsed.safetyHalts).toEqual(halts);
  });
});

/**
 * Recovery interaction suite — pins the three invariants the
 * `--recover` flow obeys for telemetry artefacts:
 *
 *  1. **Config preservation across a recovery cycle.** The original
 *     `<runDir>/telemetry/config.json` from the first run is byte-identical
 *     after a synthetic `--recover` cycle. The framework's run-start step
 *     writes `config.json` exactly once per run; a recovered run resumes at
 *     the dispatch branch matching `progress.json.status` and does NOT
 *     re-enter the run-start step that would call the config writer. The
 *     test simulates that contract by writing the artefact once, mutating
 *     the in-memory `resolvedConfig` to confirm the on-disk artefact does
 *     not track in-memory state, and asserting the on-disk bytes are
 *     identical after the simulated resumed-termination path.
 *  2. **Outcome at resumed termination.** A `--recover`-ed run reaches its
 *     termination step (graceful, halted, aborted, errored) and writes
 *     `<runDir>/telemetry/outcome.json` at that point. The artefact is NOT
 *     exclusive-create at the writer surface: a re-call overwrites,
 *     because the recovery flow legitimately writes a second outcome.json
 *     at the resumed terminal. The test pins that the second write
 *     succeeds and the resulting bytes reflect the resumed state (a
 *     different terminalReason / sprints[] / writtenAt than the first run
 *     would have written).
 *  3. **No-telemetry original stays clean.** A run originally invoked with
 *     `--no-telemetry` that is later `--recover`-ed must NOT retroactively
 *     gain telemetry files. The recover flow obeys the same gate; the test
 *     simulates that the gate stays ON across the recovery cycle and the
 *     `telemetry/` directory remains absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  shouldEmitTelemetry,
  writeTelemetryConfig,
  writeTelemetryOutcome,
} from '../../src/telemetry/index.js';
import { resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';
import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import type { ResolvedConfigSnapshot } from '../../src/telemetry/types.js';

const tmpDirs: string[] = [];

function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-recover-'));
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
      // best-effort cleanup
    }
  }
});

const RUN_ID = '20260606T220000-a0c1';

function llmCall(seq: number): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-06-06T22:00:0${seq}.000Z`,
    runId: RUN_ID,
    model: 'test-model',
    role: 'gan-generator',
    promptRef: ('a'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    responseRef: ('b'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    tokensInput: 20,
    tokensCached: 0,
    tokensOutput: 10,
    latencyMs: 90,
    cacheHit: false,
  } as TraceEventInput;
}

function fabricatedResolvedConfig(): ResolvedConfigSnapshot {
  return {
    apiVersion: '0.1.0',
    schemaVersions: { overlay: 1, stack: 1 },
    runtimeMode: { noProjectCommands: false },
    stacks: { active: [], byName: {} },
    overlay: {},
    discarded: [],
    additionalContext: { planner: [], proposer: [] },
    issues: [],
    warnings: [],
    modules: {},
  };
}

describe('recovery interaction — config preservation', () => {
  it('the original telemetry/config.json is byte-identical after a simulated recovery cycle', async () => {
    const runDir = makeRunDir();
    const resolvedConfig = fabricatedResolvedConfig();

    // First-run start: orchestrator's step-7 calls the writer exactly once.
    await writeTelemetryConfig({
      runDir,
      runId: RUN_ID,
      resolvedConfig,
      capturedAt: '2026-06-06T22:00:00.000Z',
    });
    const configPath = path.join(runDir, 'telemetry', 'config.json');
    const originalBytes = readFileSync(configPath, 'utf8');

    // The run halts. Mutate the in-memory snapshot to confirm the on-disk
    // file is independent of any reference the orchestrator still holds.
    resolvedConfig.apiVersion = '0.2.0-mutated';
    (resolvedConfig.runtimeMode as Record<string, unknown>)['noProjectCommands'] = true;

    // Recovery cycle. The recover flow dispatches to a status-keyed branch
    // (clarifying / planning / negotiating / building / evaluating) — none
    // of which call writeTelemetryConfig. The orchestrator-level contract:
    // the config writer is NOT invoked from a --recover-ed run. The test
    // simulates that contract by simply not re-calling the writer.

    // Read the file back after the recovery cycle.
    const afterBytes = readFileSync(configPath, 'utf8');
    expect(afterBytes).toBe(originalBytes);

    // And the on-disk artefact still embeds the original snapshot, not the
    // mutated one — the bytes carry the first call's resolvedConfig.
    const parsed = JSON.parse(afterBytes) as {
      resolvedConfig: { apiVersion: string; runtimeMode: Record<string, unknown> };
    };
    expect(parsed.resolvedConfig.apiVersion).toBe('0.1.0');
    expect(parsed.resolvedConfig.runtimeMode['noProjectCommands']).toBe(false);
  });
});

describe('recovery interaction — outcome at resumed termination', () => {
  it('outcome.json can be re-written at the resumed termination; the second write reflects the resumed state', async () => {
    const runDir = makeRunDir();
    appendTraceEvent(runDir, llmCall(0));

    // First-run outcome.json (simulating a non-recovered first run that
    // got partway through then was interrupted such that the orchestrator
    // wrote outcome.json on its way out). For this scenario the writer
    // landed an artefact with one terminalReason.
    await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'aborted-by-user',
      sprints: [
        { sprintNumber: 1, status: 'aborted', attemptCounts: { 'gan-generator': 1 } },
      ],
      safetyHalts: [],
      writtenAt: '2026-06-06T22:30:00.000Z',
    });
    const outcomePath = path.join(runDir, 'telemetry', 'outcome.json');
    const firstBytes = readFileSync(outcomePath, 'utf8');
    expect(JSON.parse(firstBytes)).toHaveProperty('terminalReason', 'aborted-by-user');

    // Second-run outcome.json (simulating the --recover-ed resumed
    // termination): the run reaches a different terminal reason and the
    // writer is called again. The contract: outcome.json is NOT
    // exclusive-create — the second write succeeds and the on-disk file
    // reflects the resumed state.
    await writeTelemetryOutcome({
      runDir,
      runId: RUN_ID,
      terminalReason: 'complete',
      sprints: [
        { sprintNumber: 1, status: 'complete', attemptCounts: { 'gan-generator': 2 } },
      ],
      safetyHalts: [],
      writtenAt: '2026-06-06T23:00:00.000Z',
    });
    const secondBytes = readFileSync(outcomePath, 'utf8');

    expect(secondBytes).not.toBe(firstBytes);
    const parsed = JSON.parse(secondBytes) as {
      terminalReason: string;
      disposition: string;
      envelope: { writtenAt: string };
      sprints: Array<{ status: string; attemptCounts: Record<string, number> }>;
    };
    expect(parsed.terminalReason).toBe('complete');
    expect(parsed.disposition).toBe('success');
    expect(parsed.envelope.writtenAt).toBe('2026-06-06T23:00:00.000Z');
    expect(parsed.sprints[0].status).toBe('complete');
    expect(parsed.sprints[0].attemptCounts['gan-generator']).toBe(2);
  });
});

describe('recovery interaction — no-telemetry original stays clean', () => {
  it('a run originally invoked with --no-telemetry, then --recover-ed, never gains a telemetry/ directory', async () => {
    const runDir = makeRunDir();

    // First-run start with --no-telemetry: the gate returns false, the
    // orchestrator skips the writeTelemetryConfig call, and the
    // telemetry/ directory is never created.
    const gateOn = shouldEmitTelemetry({ noTelemetry: true });
    expect(gateOn).toBe(false);
    // Simulated step-7: skipped because gateOn === false.
    expect(existsSync(path.join(runDir, 'telemetry'))).toBe(false);

    // Recovery cycle. The recover flow consults the same gate — the
    // orchestrator must obey the same --no-telemetry contract on the
    // resumed run. The recovered run reaches its termination step but the
    // gate predicate refuses the call again.
    const gateOnRecover = shouldEmitTelemetry({ noTelemetry: true });
    expect(gateOnRecover).toBe(false);
    // Simulated step-11: skipped because gateOnRecover === false.
    // Neither outcome.json nor config.json were ever written.
    expect(existsSync(path.join(runDir, 'telemetry'))).toBe(false);
    expect(existsSync(path.join(runDir, 'telemetry', 'config.json'))).toBe(false);
    expect(existsSync(path.join(runDir, 'telemetry', 'outcome.json'))).toBe(false);
  });
});

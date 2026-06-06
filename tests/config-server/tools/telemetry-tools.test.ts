/**
 * Telemetry MCP tool tests — the wire-format acceptance file for the two
 * tool wrappers (`writeTelemetryConfig`, `writeTelemetryOutcome`).
 *
 * Sections:
 *  - happy-path round-trip for each wrapper: a well-formed input lands an
 *    artefact at the expected path under `<runDir>/telemetry/` and the
 *    wrapper return surfaces `{ path, mutated: true }`;
 *  - the cross-process `droppedEmits` seam: when the caller supplies an
 *    explicit value the writer uses it verbatim; when omitted the wrapper
 *    reads `getDroppedEmits(runDir)` on this side and threads it through
 *    (so a non-zero in-process tally surfaces as `cost.complete: false`);
 *  - boundary-validator rejection: the same validators the dispatcher runs
 *    refuse malformed inputs with structured MalformedInput errors before
 *    the writer ever runs.
 *
 * The store-root is pointed at a scratch directory via `GAN_RUNS_DATA` so a
 * real `<storeRoot>/<repoKey>/runs/<runId>` is materialised on disk and the
 * `requireRunDir` boundary validator accepts it. The dropped-emits tally is
 * module-level in-memory state, so it is reset before every test case to
 * keep cases isolated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  writeTelemetryConfigTool,
  writeTelemetryOutcomeTool,
} from '../../../src/config-server/tools/telemetry.js';
import {
  writeTelemetryConfig as libraryWriteTelemetryConfig,
  writeTelemetryOutcome as libraryWriteTelemetryOutcome,
} from '../../../src/telemetry/index.js';
import {
  getDroppedEmits,
  incrementDroppedEmits,
  resetDroppedEmitsForTests,
} from '../../../src/trace/dropped-emits.js';
import { appendTraceEvent, type TraceEventInput } from '../../../src/trace/append.js';
import { ConfigServerError } from '../../../src/config-server/errors.js';
import {
  optionalDroppedEmits,
  requireResolvedConfigArg,
  requireSafetyHaltsArg,
  requireSprintsArg,
  requireTerminalReasonArg,
} from '../../../src/config-server/index.js';
import type { ResolvedConfigSnapshot } from '../../../src/telemetry/types.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'o3-tel-tools-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Build a real <storeRoot>/<repoKey>/runs/<runId> layout on disk so the
// `requireRunDir` boundary validator (decomposes against
// `resolveStoreRoot() + /<repoKey>/runs/<runId>`) accepts the runDir.
function makeStructuredRunDir(storeRoot: string, repoKey: string, runId: string): string {
  const runDir = path.join(storeRoot, repoKey, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

beforeEach(() => {
  resetDroppedEmitsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

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

function llmCall(seq: number, runId: string): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp: `2026-06-06T19:00:0${seq}.000Z`,
    runId,
    model: 'test-model',
    role: 'gan-generator',
    promptRef: ('a'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    responseRef: ('b'.repeat(60) + seq.toString(16).padStart(4, '0')).slice(-64),
    tokensInput: 10,
    tokensCached: 0,
    tokensOutput: 5,
    latencyMs: 100,
    cacheHit: false,
  } as TraceEventInput;
}

const REPO_KEY = 'tel-test-repo-deadbeef0000';
const RUN_ID = '20260606T180000-abcd';

describe('writeTelemetryConfigTool — happy path', () => {
  it('writes telemetry/config.json at the runDir-derived path and returns mutated:true', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);

    const result = await writeTelemetryConfigTool({
      runDir,
      runId: RUN_ID,
      resolvedConfig: fabricatedResolvedConfig(),
      capturedAt: '2026-06-06T18:00:00.001Z',
    });

    const expectedPath = path.join(runDir, 'telemetry', 'config.json');
    expect(result.path).toBe(expectedPath);
    expect(result.mutated).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
      envelope: { schemaVersion: number; runId: string; capturedAt: string };
      resolvedConfig: { apiVersion: string };
    };
    expect(parsed.envelope.schemaVersion).toBe(1);
    expect(parsed.envelope.runId).toBe(RUN_ID);
    expect(parsed.envelope.capturedAt).toBe('2026-06-06T18:00:00.001Z');
    expect(parsed.resolvedConfig.apiVersion).toBe('0.1.0');
  });

  it('library and tool wrappers produce byte-identical artefacts (dual-callable parity)', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDirTool = makeStructuredRunDir(
      storeRoot,
      REPO_KEY,
      '20260606T180000-tool',
    );
    const runDirLib = makeStructuredRunDir(
      storeRoot,
      REPO_KEY,
      '20260606T180000-libr',
    );
    const resolvedConfig = fabricatedResolvedConfig();

    await writeTelemetryConfigTool({
      runDir: runDirTool,
      runId: '20260606T180000-tool',
      resolvedConfig,
      capturedAt: '2026-06-06T18:00:00.001Z',
    });
    await libraryWriteTelemetryConfig({
      runDir: runDirLib,
      runId: '20260606T180000-tool',
      resolvedConfig,
      capturedAt: '2026-06-06T18:00:00.001Z',
    });

    const toolBytes = readFileSync(path.join(runDirTool, 'telemetry', 'config.json'), 'utf8');
    const libBytes = readFileSync(path.join(runDirLib, 'telemetry', 'config.json'), 'utf8');
    expect(toolBytes).toBe(libBytes);
  });
});

describe('writeTelemetryOutcomeTool — happy path', () => {
  it('writes telemetry/outcome.json at the runDir-derived path and returns mutated:true', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);

    const result = await writeTelemetryOutcomeTool({
      runDir,
      runId: RUN_ID,
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

    const expectedPath = path.join(runDir, 'telemetry', 'outcome.json');
    expect(result.path).toBe(expectedPath);
    expect(result.mutated).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
      envelope: { schemaVersion: number; runId: string; writtenAt: string };
      disposition: string;
      terminalReason: string;
    };
    expect(parsed.envelope.schemaVersion).toBe(1);
    expect(parsed.envelope.runId).toBe(RUN_ID);
    expect(parsed.disposition).toBe('success');
    expect(parsed.terminalReason).toBe('complete');
  });
});

describe('writeTelemetryOutcomeTool — cross-process droppedEmits seam', () => {
  it('explicit droppedEmits: 7 wins over a zero in-process tally → cost.complete:false', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);
    appendTraceEvent(runDir, llmCall(0, RUN_ID));
    expect(getDroppedEmits(runDir)).toBe(0);

    await writeTelemetryOutcomeTool({
      runDir,
      runId: RUN_ID,
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
      droppedEmits: 7,
    });

    const parsed = JSON.parse(
      readFileSync(path.join(runDir, 'telemetry', 'outcome.json'), 'utf8'),
    ) as { cost: { complete: boolean } | null };
    expect(parsed.cost).not.toBeNull();
    expect(parsed.cost?.complete).toBe(false);
  });

  it('explicit droppedEmits: 0 wins over a non-zero in-process tally → cost.complete:true', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);
    appendTraceEvent(runDir, llmCall(0, RUN_ID));
    incrementDroppedEmits(runDir);
    incrementDroppedEmits(runDir);
    expect(getDroppedEmits(runDir)).toBe(2);

    await writeTelemetryOutcomeTool({
      runDir,
      runId: RUN_ID,
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
      droppedEmits: 0,
    });

    const parsed = JSON.parse(
      readFileSync(path.join(runDir, 'telemetry', 'outcome.json'), 'utf8'),
    ) as { cost: { complete: boolean } | null };
    expect(parsed.cost).not.toBeNull();
    expect(parsed.cost?.complete).toBe(true);
  });

  it('omitted droppedEmits: the wrapper reads the in-process tally on this side → cost.complete:false when non-zero', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);
    appendTraceEvent(runDir, llmCall(0, RUN_ID));
    incrementDroppedEmits(runDir);

    await writeTelemetryOutcomeTool({
      runDir,
      runId: RUN_ID,
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

    const parsed = JSON.parse(
      readFileSync(path.join(runDir, 'telemetry', 'outcome.json'), 'utf8'),
    ) as { cost: { complete: boolean } | null };
    expect(parsed.cost).not.toBeNull();
    expect(parsed.cost?.complete).toBe(false);
  });

  it('omitted droppedEmits with a zero in-process tally → cost.complete:true', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDir = makeStructuredRunDir(storeRoot, REPO_KEY, RUN_ID);
    appendTraceEvent(runDir, llmCall(0, RUN_ID));
    expect(getDroppedEmits(runDir)).toBe(0);

    await writeTelemetryOutcomeTool({
      runDir,
      runId: RUN_ID,
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

    const parsed = JSON.parse(
      readFileSync(path.join(runDir, 'telemetry', 'outcome.json'), 'utf8'),
    ) as { cost: { complete: boolean } | null };
    expect(parsed.cost).not.toBeNull();
    expect(parsed.cost?.complete).toBe(true);
  });
});

describe('writeTelemetryOutcomeTool — dual-callable parity', () => {
  it('library and tool wrappers produce byte-identical artefacts when given the same explicit droppedEmits', async () => {
    const storeRoot = makeTmp('tel-store-');
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
    const runDirTool = makeStructuredRunDir(
      storeRoot,
      REPO_KEY,
      '20260606T180000-tooo',
    );
    const runDirLib = makeStructuredRunDir(
      storeRoot,
      REPO_KEY,
      '20260606T180000-libb',
    );
    appendTraceEvent(runDirTool, llmCall(0, '20260606T180000-tooo'));
    appendTraceEvent(runDirLib, llmCall(0, '20260606T180000-tooo'));

    await writeTelemetryOutcomeTool({
      runDir: runDirTool,
      runId: '20260606T180000-tooo',
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
      droppedEmits: 0,
    });
    await libraryWriteTelemetryOutcome({
      runDir: runDirLib,
      runId: '20260606T180000-tooo',
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
      droppedEmits: 0,
    });

    const toolBytes = readFileSync(
      path.join(runDirTool, 'telemetry', 'outcome.json'),
      'utf8',
    );
    const libBytes = readFileSync(
      path.join(runDirLib, 'telemetry', 'outcome.json'),
      'utf8',
    );
    expect(toolBytes).toBe(libBytes);
  });
});

describe('telemetry tools — boundary-validator refusal of malformed inputs', () => {
  // The dispatcher's boundary validators are exported individually so the
  // refusal contract can be exercised here directly — the same way the
  // skeleton tests exercise `requireRunDir`. A bad input never reaches the
  // writer; the throw carries the `MalformedInput` ConfigServerError class
  // with the offending `field` named.

  it('requireResolvedConfigArg refuses a missing argument with MalformedInput', () => {
    let threw: unknown;
    try {
      requireResolvedConfigArg({}, 'writeTelemetryConfig');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireResolvedConfigArg refuses a non-object value with MalformedInput', () => {
    let threw: unknown;
    try {
      requireResolvedConfigArg({ resolvedConfig: 'not-an-object' }, 'writeTelemetryConfig');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireTerminalReasonArg accepts every member of the closed enum', () => {
    const closedSet = [
      'complete',
      'failed-evaluation-rejected',
      'aborted-contract-failed',
      'failed-max-attempts',
      'failed-budget',
      'failed-loop-detected',
      'aborted-by-user',
      'failed-clarifier-error',
      'aborted-planner-error',
      'aborted-validation-failed',
    ];
    for (const value of closedSet) {
      expect(requireTerminalReasonArg({ terminalReason: value }, 'writeTelemetryOutcome')).toBe(
        value,
      );
    }
  });

  it('requireTerminalReasonArg refuses an out-of-enum string with MalformedInput', () => {
    let threw: unknown;
    try {
      requireTerminalReasonArg(
        { terminalReason: 'not-a-real-reason' },
        'writeTelemetryOutcome',
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireTerminalReasonArg refuses a missing field with MalformedInput', () => {
    let threw: unknown;
    try {
      requireTerminalReasonArg({}, 'writeTelemetryOutcome');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireSprintsArg accepts a well-shaped sprints array', () => {
    const input = {
      sprints: [
        { sprintNumber: 1, status: 'complete', attemptCounts: {} },
        { sprintNumber: 2, status: 'rejected', attemptCounts: { 'gan-generator': 3 } },
      ],
    };
    const result = requireSprintsArg(input, 'writeTelemetryOutcome');
    expect(result).toEqual(input.sprints);
  });

  it('requireSprintsArg refuses an entry missing sprintNumber', () => {
    let threw: unknown;
    try {
      requireSprintsArg(
        { sprints: [{ status: 'complete', attemptCounts: {} }] },
        'writeTelemetryOutcome',
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireSprintsArg refuses a non-array value', () => {
    let threw: unknown;
    try {
      requireSprintsArg({ sprints: 'not-an-array' }, 'writeTelemetryOutcome');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('requireSafetyHaltsArg accepts a well-shaped safetyHalts array (including empty)', () => {
    expect(
      requireSafetyHaltsArg({ safetyHalts: [] }, 'writeTelemetryOutcome'),
    ).toEqual([]);
    expect(
      requireSafetyHaltsArg(
        {
          safetyHalts: [
            { sprintNumber: 1, safetyClass: 'loopDetected', reason: 'editOscillation' },
          ],
        },
        'writeTelemetryOutcome',
      ),
    ).toHaveLength(1);
  });

  it('requireSafetyHaltsArg refuses an entry missing safetyClass', () => {
    let threw: unknown;
    try {
      requireSafetyHaltsArg(
        { safetyHalts: [{ sprintNumber: 1, reason: 'editOscillation' }] },
        'writeTelemetryOutcome',
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });

  it('optionalDroppedEmits returns undefined when absent and the integer when supplied', () => {
    expect(optionalDroppedEmits({})).toBeUndefined();
    expect(optionalDroppedEmits({ droppedEmits: 0 })).toBe(0);
    expect(optionalDroppedEmits({ droppedEmits: 7 })).toBe(7);
  });

  it('optionalDroppedEmits refuses a negative or non-integer value', () => {
    let threw: unknown;
    try {
      optionalDroppedEmits({ droppedEmits: -1 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');

    threw = undefined;
    try {
      optionalDroppedEmits({ droppedEmits: 1.5 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ConfigServerError);
    expect((threw as ConfigServerError).code).toBe('MalformedInput');
  });
});

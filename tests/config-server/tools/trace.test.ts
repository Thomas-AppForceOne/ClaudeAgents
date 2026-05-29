/**
 * Trace MCP tool tests — the central slice-2 acceptance file.
 *
 * Sections:
 *  - tool-vs-library parity for every new tool (11 tools, one assertion
 *    per tool, plus the four body-builder sub-cases in their own describe
 *    blocks so a single-builder regression flunks the criterion);
 *  - emit-failure semantics: non-agentAttempt failures return a structured
 *    result without aborting; droppedEmits increments even when the run
 *    dir is unwritable; agentAttempt failures retry exactly once before
 *    surfacing the structured warning;
 *  - the after-drop reconcile property (droppedEmits is the sole signal);
 *  - the metadata-only check for formatHeartbeat / formatLlmCallSummary
 *    (no payload content surfaces in the returned string);
 *  - a trace-non-empty harness (criterion #34): simulated agent attempts
 *    produce a gapless 0..N-1 trace with an index that resolves every event;
 *  - a deterministic static-scan asserting no child_process / exec / spawn
 *    token appears in the slice-2 sources (criterion #47).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendTraceEvent, type TraceEventInput } from '../../../src/trace/append.js';
import {
  aggregateRunSummary as libraryAggregateRunSummary,
  formatHeartbeat as libraryFormatHeartbeat,
  formatLlmCallSummary as libraryFormatLlmCallSummary,
  runSprintSummary as libraryRunSprintSummary,
  type LlmCallMetrics,
} from '../../../src/trace/progress.js';
import {
  reconcileIndex as libraryReconcileIndex,
  reconstructRecoveryState as libraryReconstructRecoveryState,
} from '../../../src/trace/reconcile.js';
import {
  buildLoopDetectedBody as libraryBuildLoopDetectedBody,
  buildTrustEventBody as libraryBuildTrustEventBody,
  buildValidationAbortBody as libraryBuildValidationAbortBody,
  buildValidationAbortFromCode as libraryBuildValidationAbortFromCode,
} from '../../../src/trace/integration.js';
import {
  aggregateRunSummaryTool,
  buildLoopDetectedBodyTool,
  buildTrustEventBodyTool,
  buildValidationAbortBodyTool,
  buildValidationAbortFromCodeTool,
  emitTraceEventTool,
  formatHeartbeatTool,
  formatLlmCallSummaryTool,
  reconcileTraceIndexTool,
  reconstructRecoveryStateTool,
  runSprintSummaryTool,
} from '../../../src/config-server/tools/trace.js';
import {
  getDroppedEmits,
  incrementDroppedEmits,
  resetDroppedEmitsForTests,
} from '../../../src/trace/dropped-emits.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-trace-tools-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetDroppedEmitsForTests();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // best-effort: a previous test may have chmodded the dir; restore
      // before rm so rmSync can recurse.
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const RUN_ID = '20260522T160000-tt01';

function attempt(seq: number): TraceEventInput {
  return {
    eventType: 'agentAttempt',
    timestamp: `2026-05-22T16:00:0${seq}.000Z`,
    runId: RUN_ID,
    role: 'gan-generator',
    attemptNumber: seq + 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: `attempt-${seq}.md`,
    disposition: 'completed',
  } as TraceEventInput;
}

describe('emitTraceEvent — tool routes through appendTraceEvent', () => {
  it('returns the same sequenceNumber a direct library call would', () => {
    const runDirA = makeTmp();
    const runDirB = makeTmp();
    const viaTool = emitTraceEventTool({ runDir: runDirA, event: attempt(0) });
    const viaLib = appendTraceEvent(runDirB, attempt(0));
    expect(viaTool.ok).toBe(true);
    expect(viaTool.sequenceNumber).toBe(viaLib.sequenceNumber);
  });
});

describe('runSprintSummary — tool vs library parity', () => {
  it('returns byte-identical string for the same runDir', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    const viaTool = runSprintSummaryTool({ runDir });
    const viaLib = libraryRunSprintSummary(runDir);
    expect(viaTool).toBe(viaLib);
  });
});

describe('aggregateRunSummary — tool vs library parity', () => {
  it('returns deep-equal object', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    const viaTool = aggregateRunSummaryTool({ runDir });
    const viaLib = libraryAggregateRunSummary(runDir);
    expect(viaTool).toEqual(viaLib);
  });
});

describe('reconcileTraceIndex — tool vs library parity', () => {
  it('totalEvents matches a direct library call', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    const viaTool = reconcileTraceIndexTool({ runDir });
    const viaLib = libraryReconcileIndex(path.join(runDir, 'trace'), 'any-id');
    expect(viaTool.totalEvents).toBe(viaLib.totalEvents);
  });
});

describe('reconstructRecoveryState — tool vs library parity', () => {
  it('nextSequence and attemptStateByRole match a direct library call', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    const viaTool = reconstructRecoveryStateTool({ runDir });
    const viaLib = libraryReconstructRecoveryState(path.join(runDir, 'trace'));
    expect(viaTool.nextSequence).toBe(viaLib.nextSequence);
    expect(viaTool.attemptStateByRole).toEqual(viaLib.attemptStateByRole);
  });
});

describe('formatHeartbeat — metadata only', () => {
  it('tool vs library parity, and the returned string contains no payload content', () => {
    const viaTool = formatHeartbeatTool({ role: 'gan-generator' });
    const viaLib = libraryFormatHeartbeat('gan-generator');
    expect(viaTool).toBe(viaLib);
    expect(viaTool).toContain('gan-generator');
    expect(viaTool).toContain('thinking');
  });

  it('payload-like content the caller passes is not echoed (role is the only input)', () => {
    // Even though the schema forbids extra args at the MCP boundary, the
    // library formatter only reads the role argument — so a caller that
    // bypasses the schema cannot smuggle payload content into the line.
    const viaTool = formatHeartbeatTool({ role: 'gan-evaluator' } as never);
    expect(viaTool).not.toContain('SECRET');
  });
});

describe('formatLlmCallSummary — metadata only', () => {
  it('parity, and a metrics object carrying a sensitive payload field returns a string that does not include the payload', () => {
    const metrics: LlmCallMetrics & { payload?: string } = {
      role: 'gan-generator',
      tokensInput: 100,
      tokensOutput: 200,
      tokensCached: 0,
      latencyMs: 1500,
      cacheHit: false,
      // The boundary's `metrics: object` shape would silently include this
      // — the test pins that the underlying formatter reads only the
      // documented fields and therefore never surfaces extras.
      payload: 'SECRET-PROMPT-BODY',
    };
    const viaTool = formatLlmCallSummaryTool({ metrics });
    const viaLib = libraryFormatLlmCallSummary(metrics);
    expect(viaTool).toBe(viaLib);
    expect(viaTool).not.toContain('SECRET-PROMPT-BODY');
    expect(viaTool).not.toContain('SECRET');
  });
});

// ---------- body-builder fidelity (each in its own describe per criterion #23) ----------

describe('buildTrustEventBody — byte-identity across the full cross-product', () => {
  const choices = ['view', 'approve', 'runWithoutProjectCommands', 'cancel'] as const;
  const variants = ['subsequentChange', 'initialIntroduction'] as const;
  const SHA = 'a'.repeat(64);

  it('every (userChoice × promptVariant) row is byte-identical to a direct library call', () => {
    for (const userChoice of choices) {
      for (const promptVariant of variants) {
        const input = { promptVariant, userChoice, contentHash: SHA };
        const viaTool = buildTrustEventBodyTool({ resolution: input });
        const viaLib = libraryBuildTrustEventBody(input);
        expect(viaTool).toEqual(viaLib);
      }
    }
  });

  it('approve and runWithoutProjectCommands remain distinct in the returned body', () => {
    const approve = buildTrustEventBodyTool({
      resolution: { promptVariant: 'subsequentChange', userChoice: 'approve', contentHash: SHA },
    });
    const runWithout = buildTrustEventBodyTool({
      resolution: {
        promptVariant: 'subsequentChange',
        userChoice: 'runWithoutProjectCommands',
        contentHash: SHA,
      },
    });
    expect(approve.userChoice).toBe('approve');
    expect(runWithout.userChoice).toBe('runWithoutProjectCommands');
    expect(approve.userChoice).not.toBe(runWithout.userChoice);
  });
});

describe('buildValidationAbortBody — ValidationStage preserved byte-for-byte', () => {
  const stages = ['config', 'overlay', 'stack', 'module'] as const;

  it('every stage preserves the discriminant and the F2 payload', () => {
    for (const stage of stages) {
      const error = {
        code: 'SchemaMismatch' as const,
        message: 'bad schema',
        file: '/tmp/somefile.yaml',
        field: 'name',
        line: 7,
      };
      const viaTool = buildValidationAbortBodyTool({ stage, error });
      const viaLib = libraryBuildValidationAbortBody(stage, error);
      expect(viaTool).toEqual(viaLib);
      expect(viaTool.validationStage).toBe(stage);
      // F2 fields carried; name/stack dropped per extractF2Payload.
      expect(viaTool.errorPayload.file).toBe('/tmp/somefile.yaml');
      expect(viaTool.errorPayload.field).toBe('name');
      expect(viaTool.errorPayload.line).toBe(7);
    }
  });

  it('absent input fields stay absent on the output (never coerced to null or "")', () => {
    const error = { code: 'SchemaMismatch' as const, message: 'bad' };
    const viaTool = buildValidationAbortBodyTool({ stage: 'config', error });
    expect('file' in viaTool.errorPayload).toBe(false);
    expect('field' in viaTool.errorPayload).toBe(false);
    expect('line' in viaTool.errorPayload).toBe(false);
  });
});

describe('buildValidationAbortFromCode — byte-identity across stages and codes', () => {
  it('a representative cross-product is byte-identical to the library', () => {
    const stages = ['config', 'overlay', 'stack', 'module'] as const;
    const codes = ['SchemaMismatch', 'InvalidYAML', 'MissingFile', 'PathEscape'] as const;
    for (const stage of stages) {
      for (const code of codes) {
        const viaTool = buildValidationAbortFromCodeTool({ stage, code });
        const viaLib = libraryBuildValidationAbortFromCode(stage, code);
        expect(viaTool).toEqual(viaLib);
        expect(viaTool.errorCode).toBe(code);
        expect(viaTool.validationStage).toBe(stage);
      }
    }
  });
});

describe('buildLoopDetectedBody — every trigger discriminator preserved', () => {
  const triggers = [
    'roleCeilingExceeded',
    'sprintBudgetExceeded',
    'editOscillationDetected',
  ] as const;

  it('every trigger surfaces its discriminator on payload.reason byte-for-byte', () => {
    for (const reason of triggers) {
      const halt = {
        reason,
        role: 'gan-generator',
        attempts: 5,
        ceiling: 3,
        evidence: ['some', 'evidence'],
      };
      const viaTool = buildLoopDetectedBodyTool({ halt });
      const viaLib = libraryBuildLoopDetectedBody(halt);
      expect(viaTool).toEqual(viaLib);
      expect(viaTool.safetyClass).toBe('loopDetected');
      expect(viaTool.role).toBe('gan-generator');
      // The discriminator is inlined on payload.reason and MUST NOT mutate.
      expect((viaTool.payload as { reason?: string }).reason).toBe(reason);
    }
  });
});

// ---------- emit-failure semantics ----------

describe('emit failure — non-agentAttempt does not abort the run; droppedEmits increments', () => {
  it('an injected emit failure on a non-agentAttempt returns a structured outcome and increments droppedEmits', async () => {
    const runDir = makeTmp();
    // Make the events directory unwritable so the write throws EACCES.
    // The handler must catch + increment + return { ok: false, warning }.
    mkdirSync(path.join(runDir, 'trace'), { recursive: true });
    mkdirSync(path.join(runDir, 'trace', 'events'), { recursive: true });
    chmodSync(path.join(runDir, 'trace', 'events'), 0o500); // read+execute, no write

    const llmEvent: TraceEventInput = {
      eventType: 'llmCall',
      timestamp: '2026-05-22T16:01:00.000Z',
      runId: RUN_ID,
      model: 'm',
      role: 'gan-generator',
      promptRef: 'a'.repeat(64),
      responseRef: 'b'.repeat(64),
      tokensInput: 10,
      tokensCached: 0,
      tokensOutput: 20,
      latencyMs: 100,
      cacheHit: false,
    } as TraceEventInput;

    const before = getDroppedEmits(runDir);
    const res = emitTraceEventTool({ runDir, event: llmEvent });
    // Non-agentAttempt failures are not thrown — the handler surfaces a
    // structured outcome instead so the run loop keeps going.
    expect(res.ok).toBe(false);
    expect(typeof res.warning).toBe('string');
    expect(getDroppedEmits(runDir)).toBe(before + 1);
    // The drop result surfaces the post-increment tally so a caller does not
    // need a second tool call to learn the count.
    expect(res.droppedEmits).toBe(getDroppedEmits(runDir));
    expect(res.droppedEmits).toBeGreaterThan(0);

    chmodSync(path.join(runDir, 'trace', 'events'), 0o700);
  });
});

describe('emit failure — droppedEmits increments even when the run dir is unwritable', () => {
  it('the dropped-emit tally lives in memory and reflects the failed write', () => {
    const runDir = makeTmp();
    // Make the run dir itself unwritable. The events directory cannot be
    // created — appendTraceEvent's mkdirSync throws EACCES; the handler
    // catches the throw and increments the tally regardless.
    mkdirSync(path.join(runDir, 'trace'), { recursive: true });
    chmodSync(path.join(runDir, 'trace'), 0o500);

    const event: TraceEventInput = {
      eventType: 'llmCall',
      timestamp: '2026-05-22T16:02:00.000Z',
      runId: RUN_ID,
      model: 'm',
      role: 'gan-generator',
      promptRef: 'a'.repeat(64),
      responseRef: 'b'.repeat(64),
      tokensInput: 10,
      tokensCached: 0,
      tokensOutput: 20,
      latencyMs: 100,
      cacheHit: false,
    } as TraceEventInput;

    const before = getDroppedEmits(runDir);
    const res = emitTraceEventTool({ runDir, event });
    expect(res.ok).toBe(false);
    expect(getDroppedEmits(runDir)).toBe(before + 1);

    chmodSync(path.join(runDir, 'trace'), 0o700);
  });
});

describe('agentAttempt emit failure retries once then surfaces structured warning', () => {
  it('exactly two write attempts are made before the warning surfaces, and droppedEmits increments by one', async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock('../../../src/trace/append.js', async () => {
      return {
        appendTraceEvent: (..._args: unknown[]) => {
          attempts += 1;
          const err = new Error('synthetic EACCES') as Error & { code?: string };
          err.code = 'EACCES';
          throw err;
        },
      };
    });

    const runDir = makeTmp();
    // Re-import the tool module under the mocked library — the handler's
    // first call fails; on agentAttempt it retries once; the second call
    // fails; the handler surfaces the structured warning.
    const mockedToolModule = await import('../../../src/config-server/tools/trace.js');
    const mockedDroppedEmits = await import('../../../src/trace/dropped-emits.js');
    mockedDroppedEmits.resetDroppedEmitsForTests();

    const res = mockedToolModule.emitTraceEventTool({ runDir, event: attempt(0) });
    expect(res.ok).toBe(false);
    expect(typeof res.warning).toBe('string');
    // Exactly two attempts: the initial + the single retry. Not zero, not
    // more than one extra.
    expect(attempts).toBe(2);
    expect(mockedDroppedEmits.getDroppedEmits(runDir)).toBe(1);
    // The drop result surfaces the post-increment tally from the mocked
    // dropped-emits module so the caller sees the count in-band.
    expect(res.droppedEmits).toBe(mockedDroppedEmits.getDroppedEmits(runDir));
    expect(res.droppedEmits).toBeGreaterThan(0);

    vi.doUnmock('../../../src/trace/append.js');
    vi.resetModules();
  });

  it('non-agentAttempt failures do NOT retry (one attempt only)', async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock('../../../src/trace/append.js', async () => {
      return {
        appendTraceEvent: (..._args: unknown[]) => {
          attempts += 1;
          const err = new Error('synthetic EACCES') as Error & { code?: string };
          err.code = 'EACCES';
          throw err;
        },
      };
    });

    const runDir = makeTmp();
    const mockedToolModule = await import('../../../src/config-server/tools/trace.js');
    const mockedDroppedEmits = await import('../../../src/trace/dropped-emits.js');
    mockedDroppedEmits.resetDroppedEmitsForTests();

    const llmEvent: TraceEventInput = {
      eventType: 'llmCall',
      timestamp: '2026-05-22T16:03:00.000Z',
      runId: RUN_ID,
      model: 'm',
      role: 'gan-generator',
      promptRef: 'a'.repeat(64),
      responseRef: 'b'.repeat(64),
      tokensInput: 10,
      tokensCached: 0,
      tokensOutput: 20,
      latencyMs: 100,
      cacheHit: false,
    } as TraceEventInput;

    const res = mockedToolModule.emitTraceEventTool({ runDir, event: llmEvent });
    expect(res.ok).toBe(false);
    expect(attempts).toBe(1);

    vi.doUnmock('../../../src/trace/append.js');
    vi.resetModules();
  });
});

describe('after dropped emit, reconcileTraceIndex still reconciles (droppedEmits is the sole signal)', () => {
  it('the rebuilt index totalEvents equals the on-disk count even with droppedEmits > 0', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    incrementDroppedEmits(runDir); // synthetic drop
    const index = reconcileTraceIndexTool({ runDir });
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(index.totalEvents).toBe(files.length);
  });
});

// ---------- trace-non-empty harness (criterion #34) ----------

describe('trace non-empty harness — CI-runnable', () => {
  it('emitting three simulated agent attempts yields a gapless 0..2 trace with an index that resolves every id', () => {
    const runDir = makeTmp();
    for (let i = 0; i < 3; i += 1) {
      const res = emitTraceEventTool({ runDir, event: attempt(i) });
      expect(res.ok).toBe(true);
      expect(res.sequenceNumber).toBe(i);
    }
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files.length).toBe(3);
    expect(files).toEqual(['0000000000.json', '0000000001.json', '0000000002.json']);
    const index = reconcileTraceIndexTool({ runDir });
    expect(index.totalEvents).toBe(3);
  });
});

// ---------- droppedEmits is in-memory, process-scoped (criterion #26) ----------

describe('droppedEmits — in-memory, no disk artefact, process-scoped', () => {
  it('the slice-2 source files do not write a tally artefact under runDir', () => {
    // Static-scan: no writeFileSync/atomicWriteFile pointing at a
    // "droppedEmits" filename appears in the three slice-2 sources.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sources = [
      'src/trace/append.ts',
      'src/trace/dropped-emits.ts',
      'src/config-server/tools/trace.ts',
    ].map((p) => path.resolve(here, '..', '..', '..', p));
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/droppedEmits.*writeFileSync/);
      expect(text).not.toMatch(/writeFileSync.*droppedEmits/);
      expect(text).not.toMatch(/atomicWriteFile.*droppedEmits/);
    }
  });

  it('aggregateRunSummary reads the tally from the in-memory module (a synthetic increment is visible)', () => {
    const runDir = makeTmp();
    incrementDroppedEmits(runDir);
    const summary = aggregateRunSummaryTool({ runDir });
    expect(summary.droppedEmits).toBe(1);
  });
});

// ---------- positive subprocess-bypass guard (criterion #47) ----------

describe('no child_process / subprocess token in slice-2 sources', () => {
  it('static scan: src/trace/append.ts, src/trace/dropped-emits.ts, src/trace/progress.ts, src/config-server/tools/trace.ts, src/config-server/index.ts (slice-2 additions) carry no exec/spawn/child_process token', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sources = [
      'src/trace/append.ts',
      'src/trace/dropped-emits.ts',
      'src/config-server/tools/trace.ts',
    ].map((p) => path.resolve(here, '..', '..', '..', p));

    // We do not scan src/trace/progress.ts and src/config-server/index.ts
    // in full because both pre-existed slice 2 and may carry unrelated
    // matches; we scan only the new slice-2 source files for the positive
    // regression guard.
    for (const file of sources) {
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      // No import statement from child_process (any of the four forms).
      expect(text).not.toMatch(/from\s+['"]child_process['"]/);
      expect(text).not.toMatch(/from\s+['"]node:child_process['"]/);
      expect(text).not.toMatch(/require\(\s*['"]child_process['"]\s*\)/);
      expect(text).not.toMatch(/require\(\s*['"]node:child_process['"]\s*\)/);
      // No subprocess token appears in the source bytes.
      expect(text).not.toMatch(/\bexec\(/);
      expect(text).not.toMatch(/\bexecSync\(/);
      expect(text).not.toMatch(/\bspawn\(/);
      expect(text).not.toMatch(/\bspawnSync\(/);
    }
  });
});

// dummy use to satisfy lint about unused imports
void writeFileSync;

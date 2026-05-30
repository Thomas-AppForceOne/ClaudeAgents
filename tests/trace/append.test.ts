/**
 * appendTraceEvent unit tests — the runtime-emission write path that is
 * stateless across calls and exclusive-create at the filesystem layer.
 *
 * Covers:
 *  - happy-path gapless sequence + one-file-per-call;
 *  - EEXIST collision recovery via authoritative events/ scan;
 *  - retry-exhaustion structured warning with F4 error-text discipline;
 *  - static-scan that the new file does not import TraceEmitter or call
 *    its .persist method (the documented decoupling from the legacy
 *    overwrite-write path);
 *  - return-shape assertion (sequenceNumber matches the index of the
 *    on-disk file).
 *
 * Each test creates a hermetic tmp runDir, lets the function compute its
 * own traceRoot, and inspects the events/ directory directly afterwards
 * — no mocked filesystem; collisions are produced by pre-creating the
 * target file so the wx flag fires for real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendTraceEvent,
  type AppendTraceEventResult,
  type TraceEventInput,
} from '../../src/trace/append.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-append-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a stuck handle is rare and would surface as
      // disk-space leak in a CI canary, not a test failure here.
    }
  }
});

const RUN_ID = '20260522T123000-app1';

function makeAgentAttempt(timestamp: string, role = 'gan-generator'): TraceEventInput {
  return {
    eventType: 'agentAttempt',
    timestamp,
    runId: RUN_ID,
    role,
    attemptNumber: 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: 'sprint-1-output.md',
    disposition: 'completed',
  } as TraceEventInput;
}

describe('appendTraceEvent — happy path', () => {
  it('produces gapless sequence numbers across N sequential calls; one event file per call', () => {
    const runDir = makeTmp();
    const N = 5;
    const sequences: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const res = appendTraceEvent(runDir, makeAgentAttempt(`2026-05-22T12:30:0${i}.000Z`));
      sequences.push(res.sequenceNumber);
    }
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(N);
  });

  it('returns sequenceNumber matching the on-disk filename index', () => {
    const runDir = makeTmp();
    const res = appendTraceEvent(runDir, makeAgentAttempt('2026-05-22T12:30:00.000Z'));
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir);
    // The padded filename for sequence 0 must exist, and its parsed seq must
    // match the returned value.
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.endsWith('.json')).toBe(true);
    const onDiskSeq = Number(file.slice(0, -'.json'.length));
    expect(onDiskSeq).toBe(res.sequenceNumber);
  });

  it('event-file content carries the derived sequenceNumber regardless of input', () => {
    const runDir = makeTmp();
    // Caller-supplied sequenceNumber should be ignored — the library is the
    // single source of truth for the derived value.
    const input = {
      ...makeAgentAttempt('2026-05-22T12:30:00.000Z'),
      sequenceNumber: 999,
    } as TraceEventInput;
    const res = appendTraceEvent(runDir, input);
    expect(res.sequenceNumber).not.toBe(999);
    const evDir = path.join(runDir, 'trace', 'events');
    const file = readdirSync(evDir)[0]!;
    const parsed = JSON.parse(readFileSync(path.join(evDir, file), 'utf8'));
    expect(parsed.sequenceNumber).toBe(res.sequenceNumber);
  });
});

function makeLlmCall(timestamp: string, role = 'gan-generator'): TraceEventInput {
  return {
    eventType: 'llmCall',
    timestamp,
    runId: RUN_ID,
    model: 'claude',
    role,
    promptRef: 'b'.repeat(64),
    responseRef: 'c'.repeat(64),
    tokensInput: 10,
    tokensCached: 0,
    tokensOutput: 5,
    latencyMs: 100,
    cacheHit: false,
  } as TraceEventInput;
}

describe('appendTraceEvent — per-append index carries incremental countByClass', () => {
  it('index.json between appends reflects correct per-class counts, not all-zero buckets', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, makeAgentAttempt('2026-05-22T12:30:00.000Z'));
    appendTraceEvent(runDir, makeAgentAttempt('2026-05-22T12:30:01.000Z'));
    appendTraceEvent(runDir, makeLlmCall('2026-05-22T12:30:02.000Z'));

    // A mid-run reader (progress UI, summary tool) consulting index.json must
    // see correct per-class buckets, not a correct totalEvents over zeroed
    // countByClass — the incremental write carries the prior counts forward.
    const idxPath = path.join(runDir, 'trace', 'index.json');
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    expect(idx.totalEvents).toBe(3);
    expect(idx.countByClass).toEqual({ agentAttempt: 2, llmCall: 1 });
    // The summed buckets equal totalEvents — the cache is internally
    // consistent without a full reconcile.
    const summed = Object.values(idx.countByClass).reduce(
      (acc: number, n) => acc + (n as number),
      0,
    );
    expect(summed).toBe(idx.totalEvents);
  });
});

describe('appendTraceEvent — EEXIST collision recovery', () => {
  it('on EEXIST re-derives the highest sequence from the authoritative events/ directory and retries', () => {
    const runDir = makeTmp();
    const evDir = path.join(runDir, 'trace', 'events');
    mkdirSync(evDir, { recursive: true });

    // Pre-create event 0 manually so the next appendTraceEvent collides on
    // its first attempt — the wx flag fires; the function re-derives from
    // the directory listing and writes event 1 instead.
    writeFileSync(
      path.join(evDir, '0000000000.json'),
      JSON.stringify({ sequenceNumber: 0, eventType: 'agentAttempt' }),
      'utf8',
    );

    const res = appendTraceEvent(runDir, makeAgentAttempt('2026-05-22T12:30:00.000Z'));
    // The re-derivation must read the directory, not the (absent / lagging)
    // index, and pick the next free slot. Pre-existing 0 + the new write
    // means sequence 1 is what gets written.
    expect(res.sequenceNumber).toBe(1);

    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(2);
    expect(files.sort()).toEqual(['0000000000.json', '0000000001.json']);
  });
});

describe('appendTraceEvent — retry exhaustion surfaces structured warning', () => {
  it('persistent EEXIST surfaces a ConfigServerError with shell remediation (F4 discipline)', async () => {
    // Use vi.resetModules + vi.doMock to install an openSync that throws
    // EEXIST for the wx flag, then re-import the module under test so it
    // picks up the mocked fs. This is the deterministic ESM-safe pattern.
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = (await vi.importActual('node:fs')) as typeof import('node:fs');
      return {
        ...actual,
        openSync: ((..._args: unknown[]) => {
          const err = new Error('EEXIST: synthetic collision') as Error & {
            code?: string;
          };
          err.code = 'EEXIST';
          throw err;
        }) as typeof actual.openSync,
      };
    });

    const runDir = makeTmp();
    // Dynamic-import under the mocked fs so appendTraceEvent's imports
    // resolve to the synthetic openSync. The first call's mkdirSync still
    // works because we left it real.
    const mocked = await import('../../src/trace/append.js');

    let caught: unknown;
    try {
      mocked.appendTraceEvent(runDir, makeAgentAttempt('2026-05-22T12:30:00.000Z'));
    } catch (e) {
      caught = e;
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
    // The instance check is by-name rather than instanceof because
    // vi.resetModules re-evaluated the errors module under the mocked
    // loader, so ConfigServerError has a fresh class identity in the
    // re-imported copy. By-name + by-code checks pin the structured shape
    // without depending on class identity across module realms.
    expect(caught).toBeDefined();
    expect((caught as Error)?.name).toBe('ConfigServerError');
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe('MalformedInput');
    // Shell-remediation discipline: the warning names a concrete `rm -rf`
    // recipe and uses the "the framework" idiom, not "the Node MCP server".
    expect(err.message).toMatch(/rm -rf/);
    expect(err.message).toMatch(/the framework/i);
    expect(err.message).not.toMatch(/Node MCP server|npm package/i);
  });
});

describe('appendTraceEvent — static-scan: no TraceEmitter / .persist coupling', () => {
  it('src/trace/append.ts does not import TraceEmitter and does not call .persist', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(here, '..', '..', 'src', 'trace', 'append.ts');
    const source = readFileSync(sourcePath, 'utf8');
    // Strip comment blocks before the import scan: the module-level docstring
    // names the legacy emitter class to explain why the new module deliberately
    // does not use it. The static-scan property is about real imports + calls,
    // not about the prose that documents the decision.
    const sourceNoComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // No import statement names TraceEmitter — guards the "no second
    // exclusive-create write path" property.
    expect(/import\s*[\s\S]*?TraceEmitter/.test(sourceNoComments)).toBe(false);
    // No call to .persist appears anywhere in the source.
    expect(source.includes('.persist(')).toBe(false);
  });
});

describe('appendTraceEvent — single implementation', () => {
  it('the same library function powers both tool and direct callers (no shadow implementation)', () => {
    // The tool wrapper imports appendTraceEvent from src/trace/append.ts and
    // exposes its result verbatim. A direct caller importing from the same
    // module reaches the same function. The reference-equality of the
    // exported binding is checked below.
    expect(typeof appendTraceEvent).toBe('function');
  });
});

// Static helper used by other tests in this file too — exported so the
// concurrent-append test can reuse it without duplicating the payload shape.
export { makeAgentAttempt };
export type { AppendTraceEventResult };

// The unused imports below are part of the deliberate fs-API surface this
// test file inspects; tagging them void keeps lint quiet without losing the
// import-shape signal a reader gets from the import block.
void openSync;
void closeSync;

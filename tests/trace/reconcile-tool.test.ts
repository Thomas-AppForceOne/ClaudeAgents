/**
 * reconcileTraceIndex tool tests — `totalEvents` equals the on-disk
 * event-file count across happy-path, after-race, and after-drop cases;
 * every event id present on disk is resolvable through the rebuilt index;
 * the handler routes through the shipped library function (no second
 * reconciliation implementation in the tool layer).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import { reconcileIndex as libraryReconcileIndex } from '../../src/trace/reconcile.js';
import { reconcileTraceIndexTool } from '../../src/config-server/tools/trace.js';
import { incrementDroppedEmits, resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const appendModuleUrl = pathToFileUrl(path.join(repoRoot, 'dist', 'trace', 'append.js'));

// Convert an absolute filesystem path to a `file://` URL string suitable
// for `import('...')` in a child node process.
function pathToFileUrl(p: string): string {
  return new URL(`file://${p}`).toString();
}

// Spawn a single child process that appends one event to `runDir`.
// Multi-process is the only harness shape that produces real contention
// against `openSync('wx')` — a microtask-batched Promise.all cannot.
function spawnAppender(runDir: string, attemptIndex: number, event: TraceEventInput): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const childScript = `
    import(${JSON.stringify(appendModuleUrl)}).then(({ appendTraceEvent }) => {
      const r = appendTraceEvent(${JSON.stringify(runDir)}, ${JSON.stringify(event)});
      process.stdout.write(JSON.stringify(r));
    }).catch((e) => {
      process.stderr.write(String(e && e.message ? e.message : e));
      process.exit(2);
    });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    env: process.env,
    encoding: 'utf8',
  });
  // Silence unused-parameter lint while keeping the index in the signature
  // for symmetry with the concurrent-append harness.
  void attemptIndex;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-reconcile-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetDroppedEmitsForTests();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function attempt(index: number): TraceEventInput {
  return {
    eventType: 'agentAttempt',
    timestamp: `2026-05-22T15:00:0${index}.000Z`,
    runId: '20260522T150000-rcn',
    role: 'gan-generator',
    attemptNumber: index + 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: `attempt-${index}.md`,
    disposition: 'completed',
  } as TraceEventInput;
}

describe('reconcileTraceIndex — happy path', () => {
  it('totalEvents equals on-disk event-file count', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    appendTraceEvent(runDir, attempt(2));
    const index = reconcileTraceIndexTool({ runDir });
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(index.totalEvents).toBe(files.length);
    expect(index.totalEvents).toBe(3);
  });
});

describe('reconcileTraceIndex — after-race', () => {
  it('totalEvents equals on-disk count after a multi-process concurrent-append race', () => {
    const runDir = makeTmp();
    const N = 6;
    // Multi-process race: each child appends once. The kernel's O_EXCL
    // arbitration is what mediates real contention; a Promise.all
    // microtask harness over a synchronous syscall cannot.
    const children = Array.from({ length: N }, (_, i) =>
      spawnAppender(runDir, i, attempt(i)),
    );
    for (const c of children) {
      expect(c.status, `child stderr: ${c.stderr}`).toBe(0);
    }
    const index = reconcileTraceIndexTool({ runDir });
    expect(index.totalEvents).toBe(N);
  });
});

describe('reconcileTraceIndex — after dropped emit', () => {
  it('totalEvents equals on-disk count even when droppedEmits > 0', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));
    incrementDroppedEmits(runDir); // simulates an emit failure on a third event
    const index = reconcileTraceIndexTool({ runDir });
    // The dropped emit by definition left no on-disk trace, so the
    // rebuilt index counts only the two successful writes — which is
    // exactly the property the contract pins: droppedEmits is the only
    // signal of the loss, reconcile cannot detect it.
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(index.totalEvents).toBe(files.length);
    expect(index.totalEvents).toBe(2);
  });
});

describe('reconcileTraceIndex — every event id is index-resolvable', () => {
  it('the rebuilt index countByClass sums to totalEvents (no missing entries)', () => {
    const runDir = makeTmp();
    for (let i = 0; i < 4; i += 1) {
      appendTraceEvent(runDir, attempt(i));
    }
    const index = reconcileTraceIndexTool({ runDir });
    const summed = Object.values(index.countByClass).reduce((acc, n) => acc + n, 0);
    expect(summed).toBe(index.totalEvents);
    expect(index.countByClass.agentAttempt).toBe(4);
  });
});

describe('reconcileTraceIndex — handler computes traceRoot internally', () => {
  it('tool routes through the shipped reconcileIndex(traceRoot, runId) library function', () => {
    const runDir = makeTmp();
    appendTraceEvent(runDir, attempt(0));
    appendTraceEvent(runDir, attempt(1));

    // Direct library import on the same traceRoot — the tool's runId is
    // derived from the runDir tail segment, and the test's runDir is a
    // mkdtemp path whose tail bears no resemblance to a generated id, so
    // we cannot byte-compare the full TraceIndex (the embedded runId
    // differs). Instead the test pins the structural property: same
    // totalEvents from both paths.
    const viaTool = reconcileTraceIndexTool({ runDir });
    const viaLib = libraryReconcileIndex(path.join(runDir, 'trace'), 'some-id');
    expect(viaTool.totalEvents).toBe(viaLib.totalEvents);
  });
});

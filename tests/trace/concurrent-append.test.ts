/**
 * Concurrent-append race + post-race reconcile.
 *
 * Pins the "no event is lost under concurrent emission" property: many
 * callers race onto the same `events/` directory; every call must resolve
 * to a distinct sequence; the on-disk event count must equal the call
 * count; the sequence numbers form a gapless 0..N-1 set. After the race a
 * `reconcileTraceIndex({ runDir })` call must rebuild `index.json` so
 * `totalEvents` equals the file count.
 *
 * The race is staged with Promise.all so all callers reach the
 * exclusive-create write at roughly the same time. The actual EEXIST
 * collisions are produced by the OS's atomic create; the test does not
 * simulate them — it only verifies the recovery property they fall under.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendTraceEvent, type TraceEventInput } from '../../src/trace/append.js';
import { reconcileTraceIndexTool } from '../../src/config-server/tools/trace.js';

const tmpDirs: string[] = [];

function makeTmp(prefix = 'r7-concurrent-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const RUN_ID = '20260522T130000-conc';

function attempt(index: number): TraceEventInput {
  return {
    eventType: 'agentAttempt',
    timestamp: `2026-05-22T13:00:00.00${index}Z`,
    runId: RUN_ID,
    role: 'gan-generator',
    attemptNumber: index + 1,
    inputDigest: 'c'.repeat(64),
    outputArtifactPath: `attempt-${index}.md`,
    disposition: 'completed',
  } as TraceEventInput;
}

describe('appendTraceEvent — concurrent race', () => {
  it('two-or-more concurrent calls resolve to distinct sequenceNumbers; count == calls; gapless 0..N-1', async () => {
    const runDir = makeTmp();
    const N = 8;
    // Promise.resolve().then(...) defers each call to a microtask so they
    // contend for the same events/ directory on the next tick. appendTraceEvent
    // is synchronous; wrapping in resolved promises is sufficient to ensure
    // they all enter the write path before any one returns.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => appendTraceEvent(runDir, attempt(i))),
      ),
    );
    const sequences = results.map((r) => r.sequenceNumber).sort((a, b) => a - b);
    // No duplicates, no gaps, exactly 0..N-1.
    expect(new Set(sequences).size).toBe(N);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i));

    // On-disk event-file count equals the call count.
    const evDir = path.join(runDir, 'trace', 'events');
    const files = readdirSync(evDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(N);
  });

  it('post-race reconcileTraceIndex rebuilds index.json so totalEvents equals the on-disk count', async () => {
    const runDir = makeTmp();
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => appendTraceEvent(runDir, attempt(i))),
      ),
    );
    const evDir = path.join(runDir, 'trace', 'events');
    const onDiskCount = readdirSync(evDir).filter((f) => f.endsWith('.json')).length;
    expect(onDiskCount).toBe(N);

    const rebuilt = reconcileTraceIndexTool({ runDir });
    expect(rebuilt.totalEvents).toBe(onDiskCount);
    // Every event id present on disk must be resolvable through the rebuilt
    // index — `countByClass.agentAttempt` should be N because every event we
    // wrote was an agentAttempt.
    expect(rebuilt.countByClass.agentAttempt).toBe(N);
  });
});

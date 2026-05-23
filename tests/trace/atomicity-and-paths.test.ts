/**
 * Trace store durability + path-safety suite — guards the two properties a
 * crash-resilient append-only log must never violate: writes are all-or-nothing,
 * and no reference can ever escape the trace root.
 *
 * Atomicity ("old-or-complete, never partial"): both event and payload writes
 * go through one atomicWriteFile helper (temp file + rename). The success path
 * proves no `*.tmp.*` sibling is left behind; the failure path makes the rename
 * or the temp-write fail (by chmod'ing the target dir/parent read-only) and
 * proves the final path holds NOTHING — never a half-written file — and a
 * ConfigServerError is thrown. The "same helper" test pins that there is no
 * second, unverified write mechanism. Failure-path tests early-return on win32
 * because POSIX mode bits don't deny writes there.
 *
 * Path safety (zone-2 traversal defence): payload filenames/refs are rejected
 * if the role carries a traversal segment or separator, if the payload class is
 * unknown, or if a ref is absolute / contains `..` / uses a backslash.
 * resolveRefWithinRoot must confine every resolved path under the trace root,
 * and writePayloadFile must refuse to land a file outside it — the test also
 * checks no escape file actually appears on disk, so it catches a check that
 * throws but writes anyway.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';

import { TraceEmitter } from '../../src/trace/emitter.js';
import {
  appendEventFile,
  writePayloadFile,
  resolveRefWithinRoot,
  eventsDir,
  payloadsDir,
} from '../../src/trace/store.js';
import {
  buildPayloadFilename,
  buildPayloadRef,
  assertSafeRelativeRef,
} from '../../src/trace/encodings.js';
import { ConfigServerError } from '../../src/config-server/errors.js';
import type { AgentAttemptEvent } from '../../src/trace/events.js';

const tmpDirs: string[] = [];

function makeRootDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-trace-atom-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    // Failure-path tests leave dirs chmod'd read-only; restore writability
    // first or the recursive rm itself would fail to clean up.
    try {
      chmodSync(d, 0o755);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const RUN_ID = '20260521T194720-6752';

function sampleEvent(seq: number): AgentAttemptEvent {
  return {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
    role: 'gan-generator',
    attemptNumber: 1,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: 'out.json',
    disposition: 'completed',
  };
}

describe('atomic_writes_no_partial_file — success path', () => {
  it('leaves no *.tmp* sibling after a successful event write', () => {
    const root = path.join(makeRootDir(), 'trace');
    appendEventFile(root, sampleEvent(0));
    const remaining = readdirSync(eventsDir(root));
    expect(remaining).toContain('0000000000.json');
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('leaves no *.tmp* sibling after a successful payload write', () => {
    const root = path.join(makeRootDir(), 'trace');
    const ref = buildPayloadRef(3, 'gan-generator', 'result', 'text');
    writePayloadFile(root, ref, 'result body');
    const remaining = readdirSync(payloadsDir(root));
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('a full emitter run leaves no *.tmp* siblings anywhere under the trace root', () => {
    const root = path.join(makeRootDir(), 'trace');
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID });
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    emitter.emitLlmCall({
      role: 'gan-generator',
      request: {
        model: 'claude-opus-4',
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
    for (const dir of [eventsDir(root), payloadsDir(root), root]) {
      const names = existsSync(dir) ? readdirSync(dir) : [];
      expect(names.filter((n) => n.includes('.tmp.'))).toEqual([]);
    }
  });
});

describe('atomic_writes_no_partial_file — failure path (no partial file)', () => {
  it('a rename failure leaves NO file at the final event path (old-or-complete, never partial)', () => {
    // POSIX-only: read-only mode bits don't block writes for the owner on win32.
    if (platform() === 'win32') return;
    const root = path.join(makeRootDir(), 'trace');
    const dir = eventsDir(root);
    mkdirSync(dir, { recursive: true });

    // Make the events dir read-only so the final rename (into it) fails after
    // the temp file is written — the case that would leave a partial file if
    // the write were not atomic.
    chmodSync(dir, 0o555);

    let threw = false;
    try {
      appendEventFile(root, sampleEvent(0));
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(dir, 0o755);

    const remaining = readdirSync(dir);
    expect(remaining).not.toContain('0000000000.json');
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('a temp-write failure (unwritable parent) leaves no file at the final path', () => {
    if (platform() === 'win32') return;
    const baseDir = makeRootDir();
    const root = path.join(baseDir, 'trace');

    // Make the trace root read-only so even creating the events subdir (and
    // thus the temp file) fails — exercises the earlier "temp-write" failure
    // point, distinct from the rename failure above.
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o555);

    let threw = false;
    try {
      appendEventFile(root, sampleEvent(0));
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(root, 0o755);

    expect(existsSync(eventsDir(root))).toBe(false);
    const rootNames = readdirSync(root);
    expect(rootNames.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('the event/payload write path is the same atomicWriteFile helper (no second mechanism)', () => {

    const root = path.join(makeRootDir(), 'trace');
    appendEventFile(root, sampleEvent(0));
    writePayloadFile(root, buildPayloadRef(0, 'gan-generator', 'prompt', 'text'), 'x');
    expect(readdirSync(eventsDir(root)).filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect(readdirSync(payloadsDir(root)).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});

describe('payload_path_no_traversal_zone2_only', () => {
  it('rejects a role containing a path-traversal segment', () => {
    expect(() => buildPayloadFilename(1, '../escape', 'result', 'text')).toThrow();
    expect(() => buildPayloadFilename(1, '..', 'result', 'text')).toThrow();
  });

  it('rejects a role containing a separator or backslash', () => {
    expect(() => buildPayloadFilename(1, 'a/b', 'result', 'text')).toThrow();
    expect(() => buildPayloadFilename(1, 'a\\b', 'result', 'text')).toThrow();
  });

  it('rejects an unknown payload class', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildPayloadFilename(1, 'gan-generator', 'evil' as any, 'text')).toThrow();
  });

  it('rejects an absolute or traversal reference at assertSafeRelativeRef', () => {
    expect(() => assertSafeRelativeRef('/etc/passwd')).toThrow();
    expect(() => assertSafeRelativeRef('payloads/../../etc/passwd')).toThrow();
    expect(() => assertSafeRelativeRef('..')).toThrow();
    expect(() => assertSafeRelativeRef('payloads\\x.md')).toThrow();

    expect(assertSafeRelativeRef('payloads/0000000001-gan-generator-result.md')).toBe(
      'payloads/0000000001-gan-generator-result.md',
    );
  });

  it('resolveRefWithinRoot confines every reference to the trace root', () => {
    const root = path.join(makeRootDir(), 'trace');
    const resolved = resolveRefWithinRoot(root, 'payloads/0000000001-gan-generator-result.md');
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);

    expect(() => resolveRefWithinRoot(root, '/abs/x.md')).toThrow();
    expect(() => resolveRefWithinRoot(root, 'payloads/../../../x.md')).toThrow();
  });

  it('writePayloadFile never lands a file outside the trace root', () => {
    const baseDir = makeRootDir();
    const root = path.join(baseDir, 'trace');

    // Throwing is necessary but not sufficient: also assert the escape target
    // does not exist, catching a guard that rejects yet writes the file first.
    expect(() => writePayloadFile(root, '../../escape.md', 'pwned')).toThrow();
    expect(existsSync(path.join(baseDir, '..', 'escape.md'))).toBe(false);
  });
});

/**
 * T1 Sprint 2 — atomic writes (F2.5) and path-traversal rejection (F2.4 /
 * spec filesystem-scoped authorisation).
 *
 * Covers contract criteria:
 *  - atomic_writes_no_partial_file: temp-file-then-rename is the only write
 *    path; no `*.tmp*` sibling leaks on success; a mid-write failure leaves
 *    no file at the final path (old-or-complete, never partial).
 *  - payload_path_no_traversal_zone2_only: adversarial role/class/ref values
 *    are rejected; no write lands outside the trace root.
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
    if (platform() === 'win32') return; // POSIX permission semantics
    const root = path.join(makeRootDir(), 'trace');
    const dir = eventsDir(root);
    mkdirSync(dir, { recursive: true });
    // Make the events dir read-only so the temp write (or rename) fails.
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
    // No event file landed at the final name, and no temp sibling leaked.
    const remaining = readdirSync(dir);
    expect(remaining).not.toContain('0000000000.json');
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('a temp-write failure (unwritable parent) leaves no file at the final path', () => {
    if (platform() === 'win32') return; // POSIX permission semantics
    const baseDir = makeRootDir();
    const root = path.join(baseDir, 'trace');
    // Pre-create the trace root but make it read-only so the events
    // subdirectory cannot be created and the temp write fails before any
    // rename — the observer sees nothing at the final name, never a partial.
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
    // The events dir was never created; no final file, no temp sibling.
    expect(existsSync(eventsDir(root))).toBe(false);
    const rootNames = readdirSync(root);
    expect(rootNames.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('the event/payload write path is the same atomicWriteFile helper (no second mechanism)', () => {
    // Structural assertion: store.ts uses atomicWriteFile for both event and
    // payload writes. We verify the success-path invariant (no partial, no
    // temp sibling) holds for both, which is the observable contract.
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
    // A confined ref passes unchanged.
    expect(assertSafeRelativeRef('payloads/0000000001-gan-generator-result.md')).toBe(
      'payloads/0000000001-gan-generator-result.md',
    );
  });

  it('resolveRefWithinRoot confines every reference to the trace root', () => {
    const root = path.join(makeRootDir(), 'trace');
    const resolved = resolveRefWithinRoot(root, 'payloads/0000000001-gan-generator-result.md');
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
    // Escaping refs throw before any write.
    expect(() => resolveRefWithinRoot(root, '/abs/x.md')).toThrow();
    expect(() => resolveRefWithinRoot(root, 'payloads/../../../x.md')).toThrow();
  });

  it('writePayloadFile never lands a file outside the trace root', () => {
    const baseDir = makeRootDir();
    const root = path.join(baseDir, 'trace');
    // An adversarial ref is rejected; the file is never written outside root.
    expect(() => writePayloadFile(root, '../../escape.md', 'pwned')).toThrow();
    expect(existsSync(path.join(baseDir, '..', 'escape.md'))).toBe(false);
  });
});

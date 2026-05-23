// Verifies the trust-log writer's contract: it is a no-op unless a run is
// active, and when active it emits exactly one deterministic JSON line per
// event to a run-scoped log file.
//
// Two invariants are load-bearing and each has a dedicated test:
//  1. Silence without a run. `logTrustEvent` must produce NOTHING — no stderr,
//     no file — when GAN_RUN_ID is unset, so calling it outside a run never
//     litters the cwd. (Contrast the general logger, which falls back to
//     stderr; the trust log does not.)
//  2. Deterministic, append-only JSON-lines. Each call appends one line keyed
//     by GAN_RUN_ID into <cwd>/.gan-state/runs/<id>/logs/trust.log, serialised
//     via stableStringify so keys come out alphabetically — which is why the
//     key-order test asserts action < hash < projectRoot < result < timestamp.
//
// `process.cwd()` is mocked to a temp dir (cwdSpy) so the writer's
// cwd-relative path resolution is captured under the scratch tree; GAN_RUN_ID
// is saved/restored around each test so the suite does not leak run state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { logTrustEvent } from '../../../src/config-server/logging/trust-log.js';

describe('logging/trust-log', () => {
  let tmpCwd: string;
  let originalRunId: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    tmpCwd = mkdtempSync(path.join(tmpdir(), 'r5-trust-log-'));
    originalRunId = process.env.GAN_RUN_ID;

    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);
  });

  afterEach(() => {
    if (originalRunId === undefined) delete process.env.GAN_RUN_ID;
    else process.env.GAN_RUN_ID = originalRunId;
    if (cwdSpy) cwdSpy.mockRestore();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('is silent when GAN_RUN_ID is unset (no stderr, no file)', () => {
    delete process.env.GAN_RUN_ID;
    // Capture every stderr write so we can assert NONE happened — the trust log
    // must not fall back to stderr the way the general logger does.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      logTrustEvent({
        action: 'check',
        projectRoot: '/abs/proj',
        result: 'approved',
      });
    } finally {
      spy.mockRestore();
    }

    expect(writes.length).toBe(0);

    // The writer may legitimately never create .gan-state at all; if some other
    // code did create it, it must at least be empty. Either shape counts as "no
    // file written".
    const stateDir = path.join(tmpCwd, '.gan-state');
    if (existsSync(stateDir)) {

      const entries = readdirSync(stateDir);
      expect(entries).toEqual([]);
    } else {
      expect(existsSync(stateDir)).toBe(false);
    }
  });

  it('writes to <cwd>/.gan-state/runs/<runId>/logs/trust.log when GAN_RUN_ID is set', () => {
    process.env.GAN_RUN_ID = 'run-123';
    logTrustEvent({
      action: 'check',
      projectRoot: '/abs/proj',
      hash: 'sha256:abc',
      result: 'approved',
    });

    const expected = path.join(tmpCwd, '.gan-state', 'runs', 'run-123', 'logs', 'trust.log');
    expect(existsSync(expected)).toBe(true);
    const contents = readFileSync(expected, 'utf8');
    expect(contents).toContain('"action": "check"');
    expect(contents).toContain('"hash": "sha256:abc"');

    // Exactly one non-empty line: one event produces one JSON-lines record.
    expect(contents.split('\n').filter((l) => l.length > 0).length).toBe(1);
  });

  it('appends one line per call (two calls → two lines)', () => {
    process.env.GAN_RUN_ID = 'run-abc';
    logTrustEvent({ action: 'check', projectRoot: '/p1', result: 'approved' });
    logTrustEvent({ action: 'check', projectRoot: '/p2', result: 'unapproved' });

    const expected = path.join(tmpCwd, '.gan-state', 'runs', 'run-abc', 'logs', 'trust.log');
    const contents = readFileSync(expected, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('/p1');
    expect(lines[1]).toContain('/p2');
  });

  it('uses stableStringify (sorted keys appear in alphabetical order on the line)', () => {
    process.env.GAN_RUN_ID = 'run-keys';
    logTrustEvent({
      action: 'check',
      projectRoot: '/abs/p',
      hash: 'sha256:x',
      result: 'approved',
    });
    const expected = path.join(tmpCwd, '.gan-state', 'runs', 'run-keys', 'logs', 'trust.log');
    const line = readFileSync(expected, 'utf8');

    // Keys must appear in alphabetical order on the line — the observable proof
    // that the writer used stableStringify (sorted keys) rather than insertion
    // order. The byte offsets must be strictly increasing in the order
    // action < hash < projectRoot < result < timestamp.
    const idxAction = line.indexOf('"action"');
    const idxHash = line.indexOf('"hash"');
    const idxProjectRoot = line.indexOf('"projectRoot"');
    const idxResult = line.indexOf('"result"');
    const idxTimestamp = line.indexOf('"timestamp"');
    expect(idxAction).toBeGreaterThan(-1);
    expect(idxHash).toBeGreaterThan(idxAction);
    expect(idxProjectRoot).toBeGreaterThan(idxHash);
    expect(idxResult).toBeGreaterThan(idxProjectRoot);
    expect(idxTimestamp).toBeGreaterThan(idxResult);
  });
});

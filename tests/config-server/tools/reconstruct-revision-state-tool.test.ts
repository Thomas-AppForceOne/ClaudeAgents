/**
 * MCP tool tests for `reconstructRevisionState`.
 *
 * Two properties pinned:
 *  - registration: the tool's name appears in the trace-tool group AND in
 *    the dispatcher's superset, alongside the pre-existing trace tools
 *    (`reconstructRecoveryState` in particular);
 *  - callability: invoking the wrapper against a fixture trace returns the
 *    same per-role tally the underlying pure helper returns. The test does
 *    NOT mock the tool dispatch layer — it goes through the wrapper itself
 *    so a broken wrapper would show as a divergence.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reconstructRevisionStateTool } from '../../../src/config-server/tools/trace.js';
import { reconstructRevisionState as libraryReconstructRevisionState } from '../../../src/trace/reconstruct-revision-state.js';
import {
  TRACE_TOOL_NAMES,
  DISPATCH_TOOL_NAMES,
} from '../../../src/config-server/index.js';
import { eventFilename, eventsDir } from '../../../src/trace/store.js';

const tmpDirs: string[] = [];
const RUN_ID = '20260530T230000-tt02';

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'r7-revstate-tool-'));
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

function writeRawEvent(traceRoot: string, seq: number, body: Record<string, unknown>): void {
  const dir = eventsDir(traceRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, eventFilename(seq)), JSON.stringify(body), 'utf8');
}

function agentAttempt(
  seq: number,
  role: string,
  attemptNumber: number,
  contractRevision: number,
): Record<string, unknown> {
  return {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: '2026-05-30T23:00:00.000Z',
    runId: RUN_ID,
    role,
    attemptNumber,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: `attempt-${seq}.json`,
    disposition: 'completed',
    contractRevision,
  };
}

describe('reconstructRevisionState — registration', () => {
  it("is listed in the trace tool group", () => {
    expect(TRACE_TOOL_NAMES).toContain('reconstructRevisionState');
  });

  it("is reachable via the dispatcher's superset", () => {
    expect(DISPATCH_TOOL_NAMES).toContain('reconstructRevisionState');
  });

  it('coexists with the pre-existing reconstructRecoveryState tool (does not displace siblings)', () => {
    // The new tool is additive; the previously-registered sibling must
    // still be advertised.
    expect(TRACE_TOOL_NAMES).toContain('reconstructRecoveryState');
    expect(DISPATCH_TOOL_NAMES).toContain('reconstructRecoveryState');
  });
});

describe('reconstructRevisionState — tool vs library parity', () => {
  it('returns the same per-role tally a direct library call would', () => {
    const runDir = makeTmp();
    const traceRoot = path.join(runDir, 'trace');
    writeRawEvent(traceRoot, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(traceRoot, 1, agentAttempt(1, 'gan-generator', 2, 0));
    writeRawEvent(traceRoot, 2, agentAttempt(2, 'gan-generator', 3, 1));

    const viaTool = reconstructRevisionStateTool({ runDir, contractRevision: 0 });
    const viaLib = libraryReconstructRevisionState(traceRoot, 0);

    expect(viaTool).toEqual(viaLib);
    expect(viaTool.attemptStateByRole['gan-generator']?.attemptCount).toBe(2);
  });

  it('a different revision selects a different subset (filter is wired through)', () => {
    const runDir = makeTmp();
    const traceRoot = path.join(runDir, 'trace');
    writeRawEvent(traceRoot, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(traceRoot, 1, agentAttempt(1, 'gan-generator', 2, 1));
    writeRawEvent(traceRoot, 2, agentAttempt(2, 'gan-generator', 3, 1));

    const rev0 = reconstructRevisionStateTool({ runDir, contractRevision: 0 });
    expect(rev0.attemptStateByRole['gan-generator']?.attemptCount).toBe(1);

    const rev1 = reconstructRevisionStateTool({ runDir, contractRevision: 1 });
    expect(rev1.attemptStateByRole['gan-generator']?.attemptCount).toBe(2);
  });
});

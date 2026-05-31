/**
 * Pure-helper tests for `reconstructRevisionState`.
 *
 * Three properties pinned:
 *  - filter-by-revision: a trace mixing attempts at rev 0 and rev 1 yields a
 *    per-role tally containing only the attempts for the requested revision;
 *  - missing-field default: an attempt without `contractRevision` is counted
 *    against revision 0 (the original locked contract, by convention);
 *  - per-role-tally shape: the helper's return value is shape-compatible with
 *    the shipped `checkSprintBudget` consumer (the budget call does not throw).
 *
 * Events are planted directly via `writeRawEvent` (bypassing the emitter) so
 * the suite can construct mixed-revision traces by hand without depending on
 * any orchestrator that stamps `contractRevision`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reconstructRevisionState } from '../../src/trace/reconstruct-revision-state.js';
import { eventFilename, eventsDir } from '../../src/trace/store.js';
import { checkSprintBudget } from '../../src/safety/sprint-budget.js';

const tmpDirs: string[] = [];
const RUN_ID = '20260530T230000-rev1';

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-revstate-'));
  tmpDirs.push(dir);
  return path.join(dir, 'trace');
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function writeRawEvent(root: string, seq: number, body: Record<string, unknown>): void {
  const dir = eventsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, eventFilename(seq)), JSON.stringify(body), 'utf8');
}

function agentAttempt(
  seq: number,
  role: string,
  attemptNumber: number,
  contractRevision?: number,
): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    sequenceNumber: seq,
    eventType: 'agentAttempt',
    timestamp: '2026-05-30T23:00:00.000Z',
    runId: RUN_ID,
    role,
    attemptNumber,
    inputDigest: 'a'.repeat(64),
    outputArtifactPath: `attempt-${seq}.json`,
    disposition: 'completed',
  };
  if (contractRevision !== undefined) {
    ev.contractRevision = contractRevision;
  }
  return ev;
}

describe('reconstructRevisionState — filter by contract revision', () => {
  it('returns the 3 attempts at revision 0 when asked for revision 0', () => {
    const root = makeRoot();
    // Three attempts tagged rev 0.
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 2, 0));
    writeRawEvent(root, 2, agentAttempt(2, 'gan-generator', 3, 0));
    // Two attempts tagged rev 1.
    writeRawEvent(root, 3, agentAttempt(3, 'gan-generator', 4, 1));
    writeRawEvent(root, 4, agentAttempt(4, 'gan-generator', 5, 1));

    const state = reconstructRevisionState(root, 0);
    expect(state.attemptStateByRole['gan-generator']?.attemptCount).toBe(3);
    // highestAttemptNumber is the max attemptNumber for the matching revision.
    expect(state.attemptStateByRole['gan-generator']?.highestAttemptNumber).toBe(3);
  });

  it('returns the 2 attempts at revision 1 when asked for revision 1', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 2, 0));
    writeRawEvent(root, 2, agentAttempt(2, 'gan-generator', 3, 0));
    writeRawEvent(root, 3, agentAttempt(3, 'gan-generator', 4, 1));
    writeRawEvent(root, 4, agentAttempt(4, 'gan-generator', 5, 1));

    const state = reconstructRevisionState(root, 1);
    expect(state.attemptStateByRole['gan-generator']?.attemptCount).toBe(2);
    expect(state.attemptStateByRole['gan-generator']?.highestAttemptNumber).toBe(5);
  });

  it('returns an empty per-role tally for a revision with no matching attempts', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 2, 1));

    const state = reconstructRevisionState(root, 7);
    expect(Object.keys(state.attemptStateByRole)).toHaveLength(0);
  });
});

describe('reconstructRevisionState — missing-field default (revision 0)', () => {
  it('counts an attempt without contractRevision against revision 0', () => {
    const root = makeRoot();
    // No contractRevision field on either of these two events.
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-generator', 2));
    // One explicit rev-1 attempt to prove the default is not "every revision".
    writeRawEvent(root, 2, agentAttempt(2, 'gan-generator', 3, 1));

    const rev0 = reconstructRevisionState(root, 0);
    expect(rev0.attemptStateByRole['gan-generator']?.attemptCount).toBe(2);

    const rev1 = reconstructRevisionState(root, 1);
    expect(rev1.attemptStateByRole['gan-generator']?.attemptCount).toBe(1);
  });
});

describe('reconstructRevisionState — per-role tally shape (drop-in for checkSprintBudget)', () => {
  it('feeds the result straight into checkSprintBudget without throwing', () => {
    const root = makeRoot();
    writeRawEvent(root, 0, agentAttempt(0, 'gan-generator', 1, 0));
    writeRawEvent(root, 1, agentAttempt(1, 'gan-proposer', 1, 0));
    writeRawEvent(root, 2, agentAttempt(2, 'gan-generator', 2, 0));

    const state = reconstructRevisionState(root, 0);
    // The shape contract: `attemptStateByRole` must be ingestible by the
    // shipped, unchanged budget check. A non-throwing call against a
    // large-enough budget proves the contract holds without coupling the
    // assertion to a specific halt outcome.
    expect(() =>
      checkSprintBudget({ attemptStateByRole: state.attemptStateByRole, budget: 1000 }),
    ).not.toThrow();

    // And the count the budget sees matches what was filtered in.
    const decision = checkSprintBudget({
      attemptStateByRole: state.attemptStateByRole,
      budget: 1000,
    });
    expect(decision.halt).toBe(false);
  });
});

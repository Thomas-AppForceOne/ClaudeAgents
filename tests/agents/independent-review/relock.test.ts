// Unit tests for the atomic re-lock helper.
//
// The helper's contract is the file-system equivalent of a database
// transaction over two writes: the prior canonical contract is archived to
// a `.r{k}.json` sibling, then the audited draft is atomic-renamed onto the
// canonical filename, and progress.json's status field transitions
// "building" -> "negotiating" -> "building" with contractRevision
// incrementing only on a successful swap. Every load-bearing invariant —
// atomicity, archive-then-swap ordering, crash-preserves-prior-canonical,
// status transitions, revision increment, read-modify-write on unrelated
// progress.json fields — is asserted as a separate test so a partial
// implementation cannot pass by satisfying one but missing another.
//
// Each test runs in a fresh tmp-dir built under os.tmpdir() and removed in
// afterEach so a failure cannot leak state into the next test. The runRound
// callback is a spy that records its invocation order against the on-disk
// progress.json snapshot — the test can therefore assert that "negotiating"
// is observable WHILE the callback runs (the in-flight signal) and not just
// after it returns.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  archivedContractPath,
  buildDraftPath,
  canonicalContractPath,
  relockContract,
} from '../../../src/agents/independent-review/relock.js';

const SPRINT = 2;

let runDir: string;
let progressPath: string;
let canonicalPath: string;

beforeEach(() => {
  // mkdtempSync gives each test a fresh isolated directory; the `relock-`
  // prefix makes ad-hoc cleanup grep'able if a test process is killed mid-
  // run and the afterEach hook doesn't fire.
  runDir = mkdtempSync(path.join(tmpdir(), 'relock-'));
  progressPath = path.join(runDir, 'progress.json');
  canonicalPath = canonicalContractPath(runDir, SPRINT);
});

afterEach(() => {
  // recursive + force so a partial-state test (one that intentionally
  // leaves a draft-tmp behind) doesn't cause afterEach to throw.
  rmSync(runDir, { recursive: true, force: true });
});

// Helper: read progress.json as a parsed object; returns `{}` when absent so
// a test that checks "field is absent" can assert against an empty object.
function readProgress(): Record<string, unknown> {
  if (!existsSync(progressPath)) return {};
  return JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
}

// Helper: read a JSON file at `p`; throws if missing (intentional — tests
// that read the canonical file expect it to exist).
function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

// Helper: seed the canonical contract with `body`. Returns the bytes
// written, so a test can compare a later read against the original.
function seedCanonical(body: Record<string, unknown>): string {
  const content = JSON.stringify(body);
  writeFileSync(canonicalPath, content, 'utf8');
  return content;
}

// Helper: seed progress.json with `body`. Mirrors how the orchestrator
// would have populated it before invoking the helper.
function seedProgress(body: Record<string, unknown>): void {
  writeFileSync(progressPath, JSON.stringify(body), 'utf8');
}

describe('relock_atomic_swap — successful re-lock', () => {
  it('archives the prior canonical and atomic-renames the draft onto the canonical filename', async () => {
    const priorContent = seedCanonical({ revision: 'original', criteria: [{ name: 'a' }] });
    seedProgress({
      contractRevision: 0,
      status: 'building',
      workspace: { branch: 'feature' },
    });

    const draftPath = buildDraftPath(runDir, SPRINT);
    const newContent = JSON.stringify({ revision: 'first-relock', criteria: [{ name: 'b' }] });

    const result = await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath,
      progressFilePath: progressPath,
      runRound: async () => {
        // The callback's job: write the audited draft to newDraftPath. The
        // helper itself does not author content.
        writeFileSync(draftPath, newContent, 'utf8');
      },
    });

    // Canonical now holds the new revision in full.
    expect(readFileSync(canonicalPath, 'utf8')).toBe(newContent);
    // Archive sibling is the .r0.json (k = pre-call revision index 0) and
    // holds the prior content byte-identical.
    const expectedArchive = archivedContractPath(runDir, SPRINT, 0);
    expect(result.archivedPath).toBe(expectedArchive);
    expect(readFileSync(expectedArchive, 'utf8')).toBe(priorContent);
    // newRevision is the pre-call value + 1.
    expect(result.newRevision).toBe(1);
    // Draft path no longer exists (renamed onto the canonical).
    expect(existsSync(draftPath)).toBe(false);
  });

  it('uses a draft-tmp filename that is recognisable apart from the canonical and the archived siblings', () => {
    const draftPath = buildDraftPath(runDir, SPRINT);
    // The `.draft-tmp.` infix is what a recovery flow keys on to tell
    // partial drafts apart from the canonical and from `.r{k}.json`.
    expect(path.basename(draftPath)).toMatch(/^sprint-2-contract\.draft-tmp\.[0-9a-f]+\.json$/);
    expect(draftPath).not.toBe(canonicalPath);
    expect(draftPath).not.toBe(archivedContractPath(runDir, SPRINT, 0));
  });

  it('produces a fresh draft path per call (token randomness prevents collisions)', () => {
    const a = buildDraftPath(runDir, SPRINT);
    const b = buildDraftPath(runDir, SPRINT);
    // With 6 hex chars of entropy a same-instant collision is improbable;
    // the test is asserting the entropy is present, not that it is
    // cryptographic. A constant-token implementation would deterministically
    // fail here.
    expect(a).not.toBe(b);
  });
});

describe('relock_crash_before_swap_preserves_prior_canonical', () => {
  it('a runRound rejection leaves the canonical contract byte-identical and increments nothing', async () => {
    const priorContent = seedCanonical({ revision: 'original' });
    seedProgress({ contractRevision: 3, status: 'building', workspace: { branch: 'x' } });

    const draftPath = buildDraftPath(runDir, SPRINT);
    const oops = new Error('renegotiation failed');

    await expect(
      relockContract({
        runDir,
        sprintNumber: SPRINT,
        newDraftPath: draftPath,
        progressFilePath: progressPath,
        // The callback throws before writing the draft. This simulates a
        // mid-renegotiation crash: the proposer rejected the additions, the
        // contract-reviewer audit failed, or the orchestrator was signalled.
        runRound: async () => {
          throw oops;
        },
      }),
    ).rejects.toBe(oops);

    // Canonical is byte-identical to the pre-call seed.
    expect(readFileSync(canonicalPath, 'utf8')).toBe(priorContent);
    // No draft file at the canonical filename — only the original
    // canonical sits there.
    expect(existsSync(draftPath)).toBe(false);
    // No archive sibling created (the archive step only fires on the
    // success path, after runRound resolves).
    expect(existsSync(archivedContractPath(runDir, SPRINT, 3))).toBe(false);
    // progress.json: contractRevision unchanged (no swap fired), status
    // restored to "building" (the helper never leaves "negotiating"
    // observable after it returns/throws), unrelated fields preserved.
    const p = readProgress();
    expect(p['contractRevision']).toBe(3);
    expect(p['status']).toBe('building');
    expect(p['workspace']).toEqual({ branch: 'x' });
  });

  it('a draft on disk after a crash is at a recognisable draft-tmp path (not the canonical filename)', async () => {
    seedCanonical({ revision: 'original' });
    seedProgress({ contractRevision: 0, status: 'building' });

    const draftPath = buildDraftPath(runDir, SPRINT);
    const draftContent = JSON.stringify({ revision: 'attempted' });

    await expect(
      relockContract({
        runDir,
        sprintNumber: SPRINT,
        newDraftPath: draftPath,
        progressFilePath: progressPath,
        // The callback writes the draft THEN throws (simulating a crash
        // between draft authoring and the swap). The draft must remain at
        // the draft-tmp path; the canonical must hold the prior content.
        runRound: async () => {
          writeFileSync(draftPath, draftContent, 'utf8');
          throw new Error('audit rejected the draft');
        },
      }),
    ).rejects.toThrow('audit rejected the draft');

    // Canonical untouched.
    expect(JSON.parse(readFileSync(canonicalPath, 'utf8'))).toEqual({ revision: 'original' });
    // Draft still at its draft-tmp path — distinguishable from the
    // canonical and from any archived sibling, so a recovery flow can
    // identify and ignore it.
    expect(existsSync(draftPath)).toBe(true);
    expect(readFileSync(draftPath, 'utf8')).toBe(draftContent);
    expect(path.basename(draftPath)).toContain('.draft-tmp.');
  });
});

describe('relock_progress_revision_increment', () => {
  it('increments contractRevision by 1 from the pre-call value on success', async () => {
    seedCanonical({ revision: 'r0' });
    seedProgress({ contractRevision: 0, status: 'building' });

    const draftPath = buildDraftPath(runDir, SPRINT);
    await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath,
      progressFilePath: progressPath,
      runRound: async () => {
        writeFileSync(draftPath, JSON.stringify({ revision: 'r1' }), 'utf8');
      },
    });
    expect(readProgress()['contractRevision']).toBe(1);

    // A second re-lock: pre-call 1 -> post-call 2. The archive sibling
    // for this round is .r1.json (holding what was authoritative under
    // revision 1).
    const draftPath2 = buildDraftPath(runDir, SPRINT);
    const result2 = await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath2,
      progressFilePath: progressPath,
      runRound: async () => {
        writeFileSync(draftPath2, JSON.stringify({ revision: 'r2' }), 'utf8');
      },
    });
    expect(readProgress()['contractRevision']).toBe(2);
    expect(result2.archivedPath).toBe(archivedContractPath(runDir, SPRINT, 1));
    // The first archive sibling .r0.json still exists alongside the new
    // .r1.json archive — operator-readable history is never overwritten.
    expect(existsSync(archivedContractPath(runDir, SPRINT, 0))).toBe(true);
    expect(existsSync(archivedContractPath(runDir, SPRINT, 1))).toBe(true);
  });

  it('preserves unrelated progress.json fields across the read-modify-write', async () => {
    seedCanonical({ revision: 'r0' });
    // Real-world progress.json carries many unrelated fields; the helper
    // must touch only status and contractRevision.
    seedProgress({
      contractRevision: 5,
      status: 'building',
      workspace: { worktreePath: '/x', branch: 'feature', createdByGan: true },
      terminalReason: null,
      label: 'sprint 2',
    });

    const draftPath = buildDraftPath(runDir, SPRINT);
    await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath,
      progressFilePath: progressPath,
      runRound: async () => {
        writeFileSync(draftPath, JSON.stringify({ revision: 'r6' }), 'utf8');
      },
    });

    const p = readProgress();
    expect(p['contractRevision']).toBe(6);
    expect(p['status']).toBe('building');
    expect(p['workspace']).toEqual({ worktreePath: '/x', branch: 'feature', createdByGan: true });
    expect(p['terminalReason']).toBeNull();
    expect(p['label']).toBe('sprint 2');
  });

  it('treats a missing contractRevision field as 0 (the original locked contract)', async () => {
    seedCanonical({ revision: 'original' });
    // No contractRevision key on progress.json — a fresh run that has
    // not yet recorded the field. The helper must default to 0 (the
    // original locked contract) and archive to .r0.json.
    seedProgress({ status: 'building' });

    const draftPath = buildDraftPath(runDir, SPRINT);
    const result = await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath,
      progressFilePath: progressPath,
      runRound: async () => {
        writeFileSync(draftPath, JSON.stringify({ revision: 'first' }), 'utf8');
      },
    });

    expect(result.newRevision).toBe(1);
    expect(result.archivedPath).toBe(archivedContractPath(runDir, SPRINT, 0));
    expect(readProgress()['contractRevision']).toBe(1);
  });
});

describe('relock_progress_status_negotiating', () => {
  it('sets status to "negotiating" before runRound and back to "building" after success', async () => {
    seedCanonical({ revision: 'r0' });
    seedProgress({ contractRevision: 0, status: 'building' });

    let statusDuringCallback: unknown;
    const draftPath = buildDraftPath(runDir, SPRINT);
    await relockContract({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath: draftPath,
      progressFilePath: progressPath,
      runRound: async () => {
        // Capture the on-disk status WHILE the round is in flight: this
        // is the observable signal the spec documents.
        statusDuringCallback = readProgress()['status'];
        writeFileSync(draftPath, JSON.stringify({ revision: 'r1' }), 'utf8');
      },
    });

    expect(statusDuringCallback).toBe('negotiating');
    expect(readProgress()['status']).toBe('building');
  });

  it('restores status to "building" even when runRound rejects', async () => {
    seedCanonical({ revision: 'r0' });
    seedProgress({ contractRevision: 0, status: 'building' });

    let statusDuringCallback: unknown;
    const draftPath = buildDraftPath(runDir, SPRINT);
    await expect(
      relockContract({
        runDir,
        sprintNumber: SPRINT,
        newDraftPath: draftPath,
        progressFilePath: progressPath,
        runRound: async () => {
          statusDuringCallback = readProgress()['status'];
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    // Mid-round the status WAS observable as "negotiating", proving the
    // helper actually announced the round before invoking the callback.
    expect(statusDuringCallback).toBe('negotiating');
    // After the throw the status is restored: an observer reading
    // progress.json after the helper returns must never see a stale
    // "negotiating" for a round that already terminated.
    expect(readProgress()['status']).toBe('building');
  });
});

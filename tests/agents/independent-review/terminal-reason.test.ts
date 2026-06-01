/**
 * Tests for the `failed-evaluation-rejected` terminal-reason record builder.
 *
 * Three properties pinned:
 *  - happy path: cap fired + at least one unresolved blocker returns
 *    `{ write: true, record: { terminal: true, terminalReason: "failed-evaluation-rejected" } }`;
 *  - no-op guards: (a) cap not fired and (b) cap fired with zero blockers
 *    both return `{ write: false }` with no record;
 *  - module discipline: the helper source is a pure builder — it carries no
 *    `node:fs` import, no `writeFileSync` call, and no `atomicWriteFile`
 *    composition (persistence is the caller's job, performed by the shared
 *    `writeProgressFields` primitive in `./progress.ts` and the MCP wrapper
 *    in `src/config-server/tools/independent-review.ts`).
 *
 * A separate composition test exercises the builder + `writeProgressFields`
 * pair end-to-end so the on-disk merge semantics (read-modify-write,
 * existing fields preserved, atomic temp-file + rename) are still pinned —
 * just at the persister site, not the builder site.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFailedEvaluationRejectedRecord,
  FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
} from '../../../src/agents/independent-review/terminal-reason.js';
import { writeProgressFields } from '../../../src/agents/independent-review/progress.js';
import {
  seedProgress,
  type RunContextForSeed,
} from '../../../src/config-server/storage/run-progress.js';
import { validateProgress } from '../../../src/config-server/validation/schema-check.js';

/**
 * Test-local cap-fire predicate (cluster C-5 / I-014).
 *
 * Mirrors the SKILL.md renegotiation-section prose: "the renegotiation cap
 * fires when the just-completed round number reaches the cap" — i.e. the
 * polarity is `round >= cap`. Kept deliberately test-local (rather than
 * promoted to a production module) per the phase-5 § C-5 "borrowed
 * Approach-B element" decision: the predicate has no production caller
 * today; the markdown orchestrator evaluates the comparison inline, and
 * Step 5's MCP wrapper for `writeFailedEvaluationRejected` is the
 * eventual production-side home for the `capFired` boolean. Promoting
 * the predicate to a TS module before that wrapper has a caller for it
 * would ship architectural debt this scaffold avoids — when the MCP
 * wrapper grows a caller-side predicate site (or when SKILL.md's
 * markdown orchestrator gains a TS shim), this function can be promoted
 * to a real module in a one-line edit and this test file can re-bind
 * against the new import.
 *
 * See: skills/gan/SKILL.md § "renegotiation cap" / "Cap hit with
 * unresolved blockers"; src/config-server/tools/independent-review.ts'
 * `writeFailedEvaluationRejectedTool` (Step 5's MCP wrapper).
 */
function shouldEmitCapFired(round: number, cap: number): boolean {
  return round >= cap;
}

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fer-term-reason-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const ONE_BLOCKER = [{ id: 'blocker-1' }];

describe('buildFailedEvaluationRejectedRecord — happy path', () => {
  it('returns a write decision with the literal terminal record when cap fired with one blocker', () => {
    // Deterministic clock so the terminalAt assertion is reproducible.
    const fixed = new Date('2026-06-01T03:08:30.000Z');
    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
      nowFn: () => fixed,
    });

    expect(res.write).toBe(true);
    expect(res.record).toEqual({
      terminal: true,
      terminalReason: 'failed-evaluation-rejected',
      terminalAt: '2026-06-01T03:08:30.000Z',
    });
    expect(res.record?.terminalReason).toBe(FAILED_EVALUATION_REJECTED_TERMINAL_REASON);
  });

  it('builder + writeProgressFields persists the record and preserves pre-existing fields', () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');
    // Pre-existing content the persister must not clobber.
    writeFileSync(
      progressFilePath,
      JSON.stringify({ status: 'building', contractRevision: 1, sprintNumber: 3 }),
      'utf8',
    );

    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(res.write).toBe(true);
    if (res.record !== undefined) {
      writeProgressFields(progressFilePath, res.record);
    }

    const parsed = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.status).toBe('building');
    expect(parsed.contractRevision).toBe(1);
    expect(parsed.sprintNumber).toBe(3);
    expect(parsed.terminal).toBe(true);
    expect(parsed.terminalReason).toBe('failed-evaluation-rejected');
  });
});

describe('buildFailedEvaluationRejectedRecord — no-op guards', () => {
  it('returns { write: false } when capFired is false (even if blockers are present)', () => {
    const res = buildFailedEvaluationRejectedRecord({
      capFired: false,
      unresolvedBlockers: ONE_BLOCKER,
    });

    expect(res.write).toBe(false);
    expect(res.record).toBeUndefined();
  });

  it('returns { write: false } when capFired is true but unresolvedBlockers is empty', () => {
    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: [],
    });

    expect(res.write).toBe(false);
    expect(res.record).toBeUndefined();
  });
});

describe('terminal-reason.ts — pure-builder module discipline', () => {
  it('the builder source has no fs imports and performs no I/O (persistence is left to the caller)', () => {
    // Static-scan property: the builder must remain pure. A regression that
    // re-introduced a writeFileSync call would couple the terminal-reason
    // decision to the disk write, breaking the symmetry with
    // `buildLoopHaltTerminalRecord` in src/safety/recovery.ts.
    const here = fileURLToPath(import.meta.url);
    const helperPath = path.resolve(
      path.dirname(here),
      '../../../src/agents/independent-review/terminal-reason.ts',
    );
    const src = readFileSync(helperPath, 'utf8');

    // Must NOT import node:fs or compose the atomic-write primitive directly.
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(src).not.toMatch(/writeFileSync\s*\(/);
    expect(src).not.toMatch(/atomicWriteFile/);
  });
});

// ---------------------------------------------------------------------------
// Cluster C-5 / I-014: cap-fire predicate boundary tests.
//
// The renegotiation cap's `round → capFired` decision lives only in
// SKILL.md prose today (the markdown orchestrator evaluates the
// comparison inline). Without an executable pin somewhere in source-
// controlled code, a divergent off-by-one in a future TS shim could
// ship invisibly. The test-local `shouldEmitCapFired` predicate at the
// top of this file mirrors the SKILL.md prose polarity (`round >= cap`)
// and is exercised at every boundary cliff below. When Step 5's MCP
// wrapper gains a caller-side predicate site, the test-local function
// can be promoted to a real module and these tests re-pointed.
// ---------------------------------------------------------------------------

describe('cap-fire predicate boundary (caller-side derivation)', () => {
  it.each<[number, number, boolean]>([
    // Minimum cap: a one-round budget fires on round 1.
    [1, 1, true],
    // Under-cap: round 1 of a two-round budget must NOT fire.
    [1, 2, false],
    // At-cap: round 2 of a two-round budget fires.
    [2, 2, true],
    // Below-floor: round 0 of any cap is a non-fire (no round completed).
    [0, 2, false],
    // Past-cap (defensive): round 3 of a two-round budget still fires;
    // the predicate is `>=`, not `==`, so a sticky `capFired` survives a
    // round that overruns by one.
    [3, 2, true],
  ])('round %i against cap %i -> %s', (round, cap, expected) => {
    expect(shouldEmitCapFired(round, cap)).toBe(expected);
  });

  it('the predicate output is the load-bearing input the builder routes on', () => {
    // Wire the predicate's boundary outputs through the builder so a
    // regression that decoupled the two (e.g. the builder's `capFired`
    // parameter going from `boolean` to a richer type) surfaces here.
    // Round 1 of cap 2 -> predicate false -> builder no-ops.
    const underCap = buildFailedEvaluationRejectedRecord({
      capFired: shouldEmitCapFired(1, 2),
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(underCap.write).toBe(false);

    // Round 2 of cap 2 -> predicate true -> builder writes.
    const atCap = buildFailedEvaluationRejectedRecord({
      capFired: shouldEmitCapFired(2, 2),
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(atCap.write).toBe(true);
    expect(atCap.record?.terminalReason).toBe(FAILED_EVALUATION_REJECTED_TERMINAL_REASON);
  });
});

// ---------------------------------------------------------------------------
// terminalAt + progress-v1 conformance (cluster C-2 / I-001).
//
// The schema's cross-field invariant requires terminal:true to carry both a
// non-null terminalReason AND a non-null terminalAt. The builder now stamps
// terminalAt at build time. These tests pin: (a) the seam injects a fixed
// clock; (b) the default produces a string that matches the schema's
// isoDateTime pattern; (c) a seedProgress → builder → writeProgressFields
// composition produces a document that validates clean against progressV1.
// ---------------------------------------------------------------------------

function liveRunContext(): RunContextForSeed {
  return {
    runId: '20260601T030830-1a2b',
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'feature/sample',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath: '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
    },
    overlaysAtSnapshot: {
      user: { loaded: false, path: null, hash: null },
      project: { loaded: false, path: null, hash: null },
    },
  };
}

describe('buildFailedEvaluationRejectedRecord — terminalAt emission', () => {
  it('stamps terminalAt with the injected clock when nowFn is provided', () => {
    const fixed = new Date('2026-06-01T03:08:30.500Z');
    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
      nowFn: () => fixed,
    });
    expect(res.record?.terminalAt).toBe('2026-06-01T03:08:30.500Z');
  });

  it('the default clock produces a terminalAt that matches the schema isoDateTime pattern', () => {
    // No nowFn → wall clock. Assert only the shape (the value is
    // non-deterministic).
    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(res.record?.terminalAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
  });

  it('the no-op guards do not emit a terminalAt (no record at all)', () => {
    const noCap = buildFailedEvaluationRejectedRecord({
      capFired: false,
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(noCap.record).toBeUndefined();
    const noBlockers = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: [],
    });
    expect(noBlockers.record).toBeUndefined();
  });
});

describe('buildFailedEvaluationRejectedRecord — progress-v1 conformance', () => {
  it('seedProgress + builder + writeProgressFields persists a record that validates against progressV1', () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');
    seedProgress(progressFilePath, liveRunContext());

    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });
    expect(res.write).toBe(true);
    if (res.record !== undefined) {
      writeProgressFields(progressFilePath, { ...res.record });
    }

    const onDisk = JSON.parse(readFileSync(progressFilePath, 'utf8'));
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});

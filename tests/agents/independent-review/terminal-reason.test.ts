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
    const res = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });

    expect(res.write).toBe(true);
    expect(res.record).toEqual({
      terminal: true,
      terminalReason: 'failed-evaluation-rejected',
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

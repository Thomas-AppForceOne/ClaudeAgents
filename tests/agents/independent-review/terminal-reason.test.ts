/**
 * Tests for the `failed-evaluation-rejected` terminal-reason writer.
 *
 * Three properties pinned:
 *  - happy path: cap fired + at least one unresolved blocker writes the
 *    literal `terminalReason: "failed-evaluation-rejected"` and
 *    `terminal: true` to progress.json, preserving existing fields;
 *  - no-op guards: (a) cap not fired and (b) cap fired with zero blockers
 *    both leave progress.json untouched;
 *  - atomicity: the helper uses the framework's `atomic-write.ts` primitive
 *    (temp-file + rename), not raw `fs.writeFileSync`. The check is a
 *    static-scan property — the helper's source must import atomicWriteFile
 *    and must not import writeFileSync.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
  writeFailedEvaluationRejected,
} from '../../../src/agents/independent-review/terminal-reason.js';

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

describe('writeFailedEvaluationRejected — happy path', () => {
  it('writes terminalReason and terminal:true when cap fired with one blocker', async () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');

    const res = await writeFailedEvaluationRejected({
      progressFilePath,
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });

    expect(res.written).toBe(true);
    expect(res.terminalReason).toBe('failed-evaluation-rejected');
    expect(res.terminalReason).toBe(FAILED_EVALUATION_REJECTED_TERMINAL_REASON);

    const parsed = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.terminal).toBe(true);
    expect(parsed.terminalReason).toBe('failed-evaluation-rejected');
  });

  it('preserves pre-existing fields on progress.json (read-modify-write)', async () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');
    // Pre-existing content the writer must not clobber.
    writeFileSync(
      progressFilePath,
      JSON.stringify({ status: 'building', contractRevision: 1, sprintNumber: 3 }),
      'utf8',
    );

    await writeFailedEvaluationRejected({
      progressFilePath,
      capFired: true,
      unresolvedBlockers: ONE_BLOCKER,
    });

    const parsed = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.status).toBe('building');
    expect(parsed.contractRevision).toBe(1);
    expect(parsed.sprintNumber).toBe(3);
    expect(parsed.terminal).toBe(true);
    expect(parsed.terminalReason).toBe('failed-evaluation-rejected');
  });
});

describe('writeFailedEvaluationRejected — no-op guards', () => {
  it('does NOT write when capFired is false (even if blockers are present)', async () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');

    const res = await writeFailedEvaluationRejected({
      progressFilePath,
      capFired: false,
      unresolvedBlockers: ONE_BLOCKER,
    });

    expect(res.written).toBe(false);
    expect(res.terminalReason).toBeUndefined();
    // No file should exist on disk — the writer must be a true no-op.
    expect(() => readFileSync(progressFilePath, 'utf8')).toThrow();
  });

  it('does NOT write when capFired is true but unresolvedBlockers is empty', async () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');

    const res = await writeFailedEvaluationRejected({
      progressFilePath,
      capFired: true,
      unresolvedBlockers: [],
    });

    expect(res.written).toBe(false);
    expect(res.terminalReason).toBeUndefined();
    expect(() => readFileSync(progressFilePath, 'utf8')).toThrow();
  });
});

describe('writeFailedEvaluationRejected — atomic-write discipline', () => {
  it('imports atomicWriteFile (not raw fs.writeFileSync) in the helper source', () => {
    // Static-scan property: the helper source must funnel its write through
    // the framework's atomic-write primitive. Reading the source and
    // checking imports is the lowest-coupling way to pin this without
    // mocking the fs module.
    const here = fileURLToPath(import.meta.url);
    const helperPath = path.resolve(
      path.dirname(here),
      '../../../src/agents/independent-review/terminal-reason.ts',
    );
    const src = readFileSync(helperPath, 'utf8');

    expect(src).toContain(
      "import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';",
    );
    // Must NOT depend directly on node:fs writeFileSync — the atomic
    // primitive is the only durable-write surface this helper uses.
    expect(src).not.toMatch(/writeFileSync\s*\(/);
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
  });
});

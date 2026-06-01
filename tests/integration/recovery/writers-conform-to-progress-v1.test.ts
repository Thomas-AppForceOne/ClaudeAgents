/**
 * Integration assertion: a fresh-run lifecycle drives every progress.json
 * writer in turn (seedProgress → recordWorkspace → status moves via
 * writeProgressFields → terminal-record write via the two builders), and
 * the on-disk document validates clean against the bundled `progressV1`
 * Ajv validator after each step. Closes the loop on cluster C-2 (issue
 * I-001): the schema is no longer authored against a future writer set —
 * every shipped writer's output is reconciled against the strict gate.
 *
 * The test stays light: no real run loop, no MCP wire, no orchestrator.
 * It composes the writer surface the same way the orchestrator does, in
 * the order the orchestrator does, and pins schema conformance at every
 * step a writer touches the file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  recordWorkspace,
  seedProgress,
  type RunContextForSeed,
} from '../../../src/config-server/storage/run-progress.js';
import { writeProgressFields } from '../../../src/agents/independent-review/progress.js';
import { buildFailedEvaluationRejectedRecord } from '../../../src/agents/independent-review/terminal-reason.js';
import { buildLoopHaltTerminalRecord } from '../../../src/safety/recovery.js';
import { validateProgress } from '../../../src/config-server/validation/schema-check.js';
import type { ResolvedWorkspace } from '../../../src/config-server/storage/worktree-resolver.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'recov-int-'));
  tmpDirs.push(dir);
  return dir;
}

function runContext(): RunContextForSeed {
  return {
    runId: '20260601T030830-1a2b',
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'feature/sample',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
    },
    overlaysAtSnapshot: {
      user: { loaded: false, path: null, hash: null },
      project: { loaded: false, path: null, hash: null },
    },
  };
}

function assertValid(progressPath: string, when: string): void {
  const onDisk = JSON.parse(readFileSync(progressPath, 'utf8'));
  const result = validateProgress(onDisk);
  expect(result.valid, `${when}: ${JSON.stringify(result.errors)}`).toBe(true);
}

describe('integration — fresh run + every writer output validates clean against progressV1', () => {
  it('fresh-run-to-failed-evaluation-rejected: seed → workspace → status moves → terminal record', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');

    // 1. Lock-acquire / pre-clarify: orchestrator births the document.
    seedProgress(progressPath, runContext());
    assertValid(progressPath, 'after seedProgress');

    // 2. Workspace resolution recorded.
    const resolved: ResolvedWorkspace = {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
      resolutionCase: '1c',
    };
    recordWorkspace(progressPath, resolved);
    assertValid(progressPath, 'after recordWorkspace');

    // 3. Status moves through the renegotiation loop.
    writeProgressFields(progressPath, { status: 'planning' });
    assertValid(progressPath, 'after status:planning');
    writeProgressFields(progressPath, { status: 'building' });
    assertValid(progressPath, 'after status:building');
    writeProgressFields(progressPath, { status: 'negotiating' });
    assertValid(progressPath, 'after status:negotiating');

    // 4. Terminal record: cap-with-blockers rejection.
    const built = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: [{ id: 'b-1' }],
    });
    expect(built.write).toBe(true);
    if (built.record !== undefined) {
      writeProgressFields(progressPath, { ...built.record });
    }
    assertValid(progressPath, 'after failed-evaluation-rejected terminal record');
  });

  it('fresh-run-to-failed-loop-detected: seed → workspace → loop-halt terminal record', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');

    seedProgress(progressPath, runContext());
    assertValid(progressPath, 'after seedProgress');

    recordWorkspace(progressPath, {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
      resolutionCase: '1c',
    });
    assertValid(progressPath, 'after recordWorkspace');

    const record = buildLoopHaltTerminalRecord();
    writeProgressFields(progressPath, { ...record });
    assertValid(progressPath, 'after failed-loop-detected terminal record');
  });
});

/**
 * MCP wire tests for the three independent-review tool wrappers.
 *
 * Three property classes pinned:
 *
 *  - Registration: every tool name appears in `INDEPENDENT_REVIEW_TOOL_NAMES`
 *    AND in the dispatcher's `DISPATCH_TOOL_NAMES` superset; the surface is
 *    additive (does not displace any pre-existing tool).
 *
 *  - Behaviour: the wrappers compose the library + shared persister +
 *    atomic-write into the wire shape the SKILL.md prose names. The
 *    relock wrapper performs the archive + swap + RMW protocol without
 *    requiring a TS callback; the writeFailedEvaluationRejected wrapper
 *    composes the pure builder with the persister; the validateFindings
 *    wrapper installs a safe-by-default `/bin/sh -c` runner and produces
 *    the same drop verdicts a direct library import would for equal input.
 *
 *  - Pre-existing tool coexistence: the new tools do not collide with the
 *    trace / safety / docker / evaluator / run-context tool groups already
 *    in the dispatch table.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  relockContractTool,
  validateFindingsTool,
  writeFailedEvaluationRejectedTool,
} from '../../../src/config-server/tools/independent-review.js';
import {
  archivedContractPath,
  buildDraftPath,
  canonicalContractPath,
} from '../../../src/agents/independent-review/relock.js';
import {
  DISPATCH_TOOL_NAMES,
  INDEPENDENT_REVIEW_TOOL_NAMES,
  RUN_CONTEXT_TOOL_NAMES,
  TRACE_TOOL_NAMES,
} from '../../../src/config-server/index.js';
import type { IndependentReviewBundle } from '../../../src/agents/independent-review/types.js';

const tmpDirs: string[] = [];
const SPRINT = 2;

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ir-tools-'));
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

describe('independent-review tools — registration', () => {
  it('every new tool is listed in INDEPENDENT_REVIEW_TOOL_NAMES', () => {
    expect(INDEPENDENT_REVIEW_TOOL_NAMES).toContain('relockContract');
    expect(INDEPENDENT_REVIEW_TOOL_NAMES).toContain('writeFailedEvaluationRejected');
    expect(INDEPENDENT_REVIEW_TOOL_NAMES).toContain('validateFindings');
  });

  it('every new tool is reachable via the dispatcher superset', () => {
    expect(DISPATCH_TOOL_NAMES).toContain('relockContract');
    expect(DISPATCH_TOOL_NAMES).toContain('writeFailedEvaluationRejected');
    expect(DISPATCH_TOOL_NAMES).toContain('validateFindings');
  });

  it('coexists additively with pre-existing tool groups (no displacement)', () => {
    // The new tools are an additive surface; they must not collide with
    // any pre-existing group name. The trace / run-context exemplars are
    // representative — if a future refactor merges or removes a tool
    // group, this test surfaces it.
    for (const name of TRACE_TOOL_NAMES) {
      expect(INDEPENDENT_REVIEW_TOOL_NAMES).not.toContain(name);
    }
    for (const name of RUN_CONTEXT_TOOL_NAMES) {
      expect(INDEPENDENT_REVIEW_TOOL_NAMES).not.toContain(name);
    }
  });
});

describe('relockContractTool — wire-side archive + swap + RMW (no callback)', () => {
  it('archives the prior canonical and atomic-renames the supplied draft onto the canonical filename', () => {
    const runDir = makeTmp();
    const progressFilePath = path.join(runDir, 'progress.json');
    const canonical = canonicalContractPath(runDir, SPRINT);

    // Pre-state: canonical holds the prior revision; progress has
    // contractRevision: 0.
    const priorContent = JSON.stringify({ revision: 'original' });
    writeFileSync(canonical, priorContent, 'utf8');
    writeFileSync(
      progressFilePath,
      JSON.stringify({ contractRevision: 0, status: 'building' }),
      'utf8',
    );

    // The orchestrator writes the draft itself before invoking the tool —
    // the wire wrapper omits the library's runRound callback.
    const newDraftPath = buildDraftPath(runDir, SPRINT);
    const newContent = JSON.stringify({ revision: 'first-relock' });
    writeFileSync(newDraftPath, newContent, 'utf8');

    const result = relockContractTool({
      runDir,
      sprintNumber: SPRINT,
      newDraftPath,
      progressFilePath,
    });

    expect(result.newRevision).toBe(1);
    expect(result.archivedPath).toBe(archivedContractPath(runDir, SPRINT, 0));
    expect(result.mutated).toBe(true);
    expect(readFileSync(canonical, 'utf8')).toBe(newContent);
    expect(readFileSync(archivedContractPath(runDir, SPRINT, 0), 'utf8')).toBe(priorContent);
    expect(existsSync(newDraftPath)).toBe(false);

    const progress = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(progress.contractRevision).toBe(1);
    expect(progress.status).toBe('building');
  });

  it('refuses when newDraftPath is absent and leaves the canonical byte-identical', () => {
    const runDir = makeTmp();
    const progressFilePath = path.join(runDir, 'progress.json');
    const canonical = canonicalContractPath(runDir, SPRINT);
    const priorContent = JSON.stringify({ revision: 'original' });
    writeFileSync(canonical, priorContent, 'utf8');
    writeFileSync(
      progressFilePath,
      JSON.stringify({ contractRevision: 0, status: 'building' }),
      'utf8',
    );
    // Pointed-at path the orchestrator forgot to write.
    const missingDraftPath = path.join(runDir, 'sprint-2-contract.draft-tmp.deadbeef.json');

    expect(() =>
      relockContractTool({
        runDir,
        sprintNumber: SPRINT,
        newDraftPath: missingDraftPath,
        progressFilePath,
      }),
    ).toThrow(/newDraftPath does not exist/);

    // Canonical untouched; status restored to building from the catch.
    expect(readFileSync(canonical, 'utf8')).toBe(priorContent);
    expect(existsSync(archivedContractPath(runDir, SPRINT, 0))).toBe(false);
    const progress = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(progress.contractRevision).toBe(0);
    expect(progress.status).toBe('building');
  });

  it('preserves unrelated progress.json fields across the RMW', () => {
    const runDir = makeTmp();
    const progressFilePath = path.join(runDir, 'progress.json');
    const canonical = canonicalContractPath(runDir, SPRINT);
    writeFileSync(canonical, JSON.stringify({ revision: 'original' }), 'utf8');
    writeFileSync(
      progressFilePath,
      JSON.stringify({
        contractRevision: 0,
        status: 'building',
        workspace: { branch: 'feature' },
        label: 'sprint 2',
      }),
      'utf8',
    );
    const newDraftPath = buildDraftPath(runDir, SPRINT);
    writeFileSync(newDraftPath, JSON.stringify({ revision: 'r1' }), 'utf8');

    relockContractTool({ runDir, sprintNumber: SPRINT, newDraftPath, progressFilePath });

    const progress = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(progress.workspace).toEqual({ branch: 'feature' });
    expect(progress.label).toBe('sprint 2');
    expect(progress.contractRevision).toBe(1);
    expect(progress.status).toBe('building');
  });
});

describe('writeFailedEvaluationRejectedTool — wire-side builder + persister composition', () => {
  it('writes terminal: true + terminalReason and preserves pre-existing fields when cap fires with blockers', () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');
    writeFileSync(
      progressFilePath,
      JSON.stringify({ status: 'building', contractRevision: 2, label: 'sprint 3' }),
      'utf8',
    );

    const res = writeFailedEvaluationRejectedTool({
      progressFilePath,
      capFired: true,
      unresolvedBlockers: [{ id: 'b-1' }],
    });

    expect(res.write).toBe(true);
    expect(res.mutated).toBe(true);
    expect(res.record).toEqual({
      terminal: true,
      terminalReason: 'failed-evaluation-rejected',
    });

    const parsed = JSON.parse(readFileSync(progressFilePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.terminal).toBe(true);
    expect(parsed.terminalReason).toBe('failed-evaluation-rejected');
    expect(parsed.contractRevision).toBe(2);
    expect(parsed.label).toBe('sprint 3');
    expect(parsed.status).toBe('building');
  });

  it('is a true no-op when capFired is false (mutated: false; file untouched)', () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');

    const res = writeFailedEvaluationRejectedTool({
      progressFilePath,
      capFired: false,
      unresolvedBlockers: [{ id: 'b-1' }],
    });

    expect(res.write).toBe(false);
    expect(res.mutated).toBe(false);
    expect(existsSync(progressFilePath)).toBe(false);
  });

  it('is a true no-op when unresolvedBlockers is empty (mutated: false; file untouched)', () => {
    const dir = makeTmp();
    const progressFilePath = path.join(dir, 'progress.json');

    const res = writeFailedEvaluationRejectedTool({
      progressFilePath,
      capFired: true,
      unresolvedBlockers: [],
    });

    expect(res.write).toBe(false);
    expect(res.mutated).toBe(false);
    expect(existsSync(progressFilePath)).toBe(false);
  });
});

describe('validateFindingsTool — wire-side gate with default safe runner', () => {
  it('keeps inspection findings unchanged and routes them through without running shell', () => {
    const bundle: IndependentReviewBundle = {
      sprintNumber: 1,
      attemptLetter: 'A',
      contractRevision: 0,
      findings: [
        {
          id: 'insp-1',
          kind: 'inspection',
          severity: 'warning',
          category: 'correctness',
          file: 'src/foo.ts',
          line: 10,
          description: 'unverified claim',
          suggestedCriterion: 'add assertion',
          evidencePointer: 'src/foo.ts:10 — claim text',
        },
      ],
      summary: { blockers: 0, warnings: 1, advisories: 0, dropped: 0 },
    };

    const result = validateFindingsTool({ bundle });

    expect(result.bundle.findings).toHaveLength(1);
    expect(result.bundle.findings[0]?.id).toBe('insp-1');
    expect(result.droppedReasons).toEqual([]);
    expect(result.bundle.summary.warnings).toBe(1);
    expect(result.bundle.summary.dropped).toBe(0);
  });

  it('drops a command finding whose reproduction command exits non-zero with reproduction-failed', () => {
    // `false` is a portable POSIX builtin/utility that always exits 1.
    const bundle: IndependentReviewBundle = {
      sprintNumber: 1,
      attemptLetter: 'A',
      contractRevision: 0,
      findings: [
        {
          id: 'cmd-1',
          kind: 'command',
          severity: 'blocker',
          category: 'correctness',
          file: 'src/foo.ts',
          line: 10,
          description: 'non-reproducing',
          suggestedCriterion: 'fix the bug',
          reproductionCommand: 'false',
          reproduced: false,
        },
      ],
      summary: { blockers: 1, warnings: 0, advisories: 0, dropped: 0 },
    };

    const result = validateFindingsTool({ bundle });

    expect(result.bundle.findings).toEqual([]);
    expect(result.droppedReasons).toEqual([{ id: 'cmd-1', reason: 'reproduction-failed' }]);
    expect(result.bundle.summary.blockers).toBe(0);
    expect(result.bundle.summary.dropped).toBe(1);
  });

  it('keeps a command finding whose reproduction command exits zero', () => {
    // `true` is a portable POSIX builtin/utility that always exits 0.
    const bundle: IndependentReviewBundle = {
      sprintNumber: 1,
      attemptLetter: 'A',
      contractRevision: 0,
      findings: [
        {
          id: 'cmd-keep',
          kind: 'command',
          severity: 'blocker',
          category: 'correctness',
          file: 'src/foo.ts',
          line: 10,
          description: 'reproduces',
          suggestedCriterion: 'fix the bug',
          reproductionCommand: 'true',
          reproduced: true,
        },
      ],
      summary: { blockers: 1, warnings: 0, advisories: 0, dropped: 0 },
    };

    const result = validateFindingsTool({ bundle });

    expect(result.bundle.findings).toHaveLength(1);
    expect(result.bundle.findings[0]?.id).toBe('cmd-keep');
    expect(result.droppedReasons).toEqual([]);
    expect(result.bundle.summary.blockers).toBe(1);
    expect(result.bundle.summary.dropped).toBe(0);
  });
});

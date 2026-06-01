/**
 * Tests for the run-progress writer surface: the fresh-document seed
 * primitive (`seedProgress`), the workspace-only narrow update
 * (`recordWorkspace`), and the schema-aware write gate
 * (`assertValidProgress` + `progressDocumentIsComplete`).
 *
 * The properties pinned here are exactly the ones the cluster C-2 fix
 * relies on:
 *
 *  - seedProgress births a document with the full 17-field required set
 *    populated; the on-disk JSON validates clean against the bundled
 *    `progressV1` Ajv validator.
 *  - seedProgress is idempotent at the document level: re-seeding produces
 *    byte-identical content for byte-identical inputs.
 *  - The atomic-write contract: a target written here is a final on-disk
 *    file, not a half-state temp; the write is wholesale (the test asserts
 *    no `.tmp.` debris is stranded after a successful write).
 *  - recordWorkspace preserves the seeded required-set: a seed-then-narrow-
 *    update sequence still validates against `progressV1`.
 *  - The write gate is conditional: a partial pre-seed shape (the legacy
 *    test fixture pattern other suites in this repo use) is tolerated, so
 *    callers that legitimately write partial documents continue to work; a
 *    *complete* document that violates the schema (e.g. a cross-field
 *    invariant) is rejected with a SchemaMismatch error rather than
 *    silently persisted.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertValidProgress,
  progressDocumentIsComplete,
  recordWorkspace,
  seedProgress,
  type RunContextForSeed,
} from '../../../src/config-server/storage/run-progress.js';
import { validateProgress } from '../../../src/config-server/validation/schema-check.js';
import type { ResolvedWorkspace } from '../../../src/config-server/storage/worktree-resolver.js';

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-progress-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeRunContext(overrides: Partial<RunContextForSeed> = {}): RunContextForSeed {
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
    ...overrides,
  };
}

describe('seedProgress — fresh-document seed', () => {
  it('writes a document that carries every required top-level field', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    expect(existsSync(progressPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    // Every required top-level key per progress-v1.json.
    for (const k of [
      'runId',
      'status',
      'currentSprint',
      'currentAttempt',
      'contractRevision',
      'totalSprints',
      'completedSprints',
      'projectRoot',
      'runBranch',
      'baseBranch',
      'startingBranch',
      'workspace',
      'terminal',
      'terminalReason',
      'terminalAt',
      'overlaysAtSnapshot',
      'recoveryHistory',
    ]) {
      expect(parsed).toHaveProperty(k);
    }
  });

  it('the seeded document validates clean against the bundled progress-v1 Ajv validator', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    const parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
    const result = validateProgress(parsed);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('writes the in-flight null-terminal triple (terminal:false, terminalReason:null, terminalAt:null)', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    const parsed = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    // The schema's allOf[1] branch demands terminal:false ⇒ both null.
    expect(parsed.terminal).toBe(false);
    expect(parsed.terminalReason).toBeNull();
    expect(parsed.terminalAt).toBeNull();
  });

  it('is idempotent at the document level: re-seeding with the same context produces byte-identical content', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    const ctx = makeRunContext();
    seedProgress(progressPath, ctx);
    const first = readFileSync(progressPath, 'utf8');
    seedProgress(progressPath, ctx);
    const second = readFileSync(progressPath, 'utf8');
    expect(second).toBe(first);
  });

  it('leaves no temp-file debris after a successful write (atomic semantics)', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    const siblings = readdirSync(dir);
    // The final file must exist; no `.tmp.` siblings should remain.
    expect(siblings).toContain('progress.json');
    for (const name of siblings) {
      expect(name).not.toMatch(/\.tmp\./);
    }
  });
});

describe('recordWorkspace — preserves the seeded required-set', () => {
  it('after seedProgress + recordWorkspace the on-disk document still validates against progress-v1', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    const resolved: ResolvedWorkspace = {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
      resolutionCase: '1c',
    };
    recordWorkspace(progressPath, resolved);

    const parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
    const result = validateProgress(parsed);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('replaces only the workspace key — every other seeded field survives', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    const ctx = makeRunContext();
    seedProgress(progressPath, ctx);

    recordWorkspace(progressPath, {
      worktreePath: '/Users/example/different/worktree',
      branch: 'feature/sample',
      createdByGan: false,
      resolutionCase: '1a',
    });

    const parsed = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    // The narrow update set workspace.createdByGan to false; the rest of
    // the seed-supplied required set survived verbatim.
    expect((parsed.workspace as { createdByGan: boolean }).createdByGan).toBe(false);
    expect(parsed.runId).toBe(ctx.runId);
    expect(parsed.projectRoot).toBe(ctx.projectRoot);
    expect(parsed.runBranch).toBe(ctx.runBranch);
    expect(parsed.baseBranch).toBe(ctx.baseBranch);
    expect(parsed.startingBranch).toBe(ctx.startingBranch);
    expect(parsed.status).toBe('clarifying');
    expect(parsed.recoveryHistory).toEqual([]);
  });
});

describe('progressDocumentIsComplete — gate predicate', () => {
  it('returns true for a seedProgress-produced document', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());
    const parsed = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    expect(progressDocumentIsComplete(parsed)).toBe(true);
  });

  it('returns false for a partial pre-seed test-fixture shape', () => {
    // The shape the existing relock tests pre-seed by hand. The gate
    // tolerates this so partial-doc test fixtures continue to work.
    expect(
      progressDocumentIsComplete({
        contractRevision: 0,
        status: 'building',
        workspace: { branch: 'feature' },
      }),
    ).toBe(false);
  });

  it('returns false when a single required key is missing', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());
    const parsed = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    delete parsed.terminalAt;
    expect(progressDocumentIsComplete(parsed)).toBe(false);
  });
});

describe('assertValidProgress — write-gate behaviour', () => {
  it('does not throw on a partial pre-seed shape (validation is skipped when incomplete)', () => {
    expect(() =>
      assertValidProgress('/tmp/fake.json', {
        contractRevision: 0,
        status: 'building',
        workspace: { branch: 'feature' },
      }),
    ).not.toThrow();
  });

  it('throws SchemaMismatch on a complete document that violates the cross-field invariant (terminal:true + null terminalAt)', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());
    const seeded = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    // Flip to terminal:true but leave terminalAt null — the half-terminal
    // shape the schema's if/then is designed to catch.
    seeded.terminal = true;
    seeded.terminalReason = 'complete';
    seeded.terminalAt = null;

    expect(() => assertValidProgress(progressPath, seeded)).toThrow();
  });

  it('throws SchemaMismatch on a complete document with an unknown top-level field (additionalProperties:false)', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());
    const seeded = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    seeded['unknownField'] = 'oops';

    expect(() => assertValidProgress(progressPath, seeded)).toThrow();
  });

  it('does not throw on a complete, schema-conforming document', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());
    const seeded = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    expect(() => assertValidProgress(progressPath, seeded)).not.toThrow();
  });
});

describe('recordWorkspace — write-gate interaction with seeded documents', () => {
  it('throws when a narrow workspace update would clobber a required nested field on a fully-seeded doc', () => {
    const dir = makeTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, makeRunContext());

    // Tamper with the seeded document so the post-update merge produces an
    // invariant violation (e.g. a writer accidentally sets terminal:true
    // without supplying the full triple). recordWorkspace itself only
    // touches `workspace`, but assertValidProgress sees the full merged
    // document, so the tamper is caught.
    const seeded = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    seeded.terminal = true; // and terminalReason/At still null from seed
    writeFileSync(progressPath, JSON.stringify(seeded), 'utf8');

    expect(() =>
      recordWorkspace(progressPath, {
        worktreePath: '/Users/example/projects/sample-app/.gan-state/runs/x/worktree',
        branch: 'feature/sample',
        createdByGan: true,
        resolutionCase: '1c',
      }),
    ).toThrow();
  });
});

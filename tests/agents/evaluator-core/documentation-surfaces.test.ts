

import { describe, expect, it } from 'vitest';

import {
  buildDocumentationSurfacesInstantiated,
  isKnownSurfaceId,
} from '../../../src/agents/evaluator-core/index.js';
import type {
  EvaluatorCoreSnapshot,
  SprintPlan,
  WorktreeState,
} from '../../../src/agents/evaluator-core/index.js';

const DOC_PUBLIC_CONTRACT_TEMPLATE =
  "Every exported function, class, or type documents each parameter's meaning, " +
  'failure modes, side effects, and invariants.';

const DOC_SCOPE_ONLY_TEMPLATE =
  'Every comment explains a constraint, invariant, or non-obvious decision and its rationale.';

function webNodeStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'web-node',
    scope: ['**/*.ts', '**/*.tsx'],

    securitySurfaces: [
      {
        id: 'route_input_validation',
        template: 'Validate untrusted route input.',
        triggers: { scope: ['**/*.ts'], keywords: ['req.query'] },
      },
    ],
    documentationSurfaces: [
      {
        id: 'public_contract_completeness',
        template: DOC_PUBLIC_CONTRACT_TEMPLATE,
        triggers: {
          keywords: ['export function', 'export class', 'export const', 'export interface'],
          scope: ['**/*.ts', '**/*.tsx'],
        },
      },
      {
        id: 'comments_explain_why_not_what',
        template: DOC_SCOPE_ONLY_TEMPLATE,
        triggers: { scope: ['**/*.ts', '**/*.tsx'] },
      },
    ],
  };
}

function secondStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'synthetic-second',
    scope: ['**/*.synth'],
    documentationSurfaces: [
      {

        id: 'public_contract_completeness',
        template: 'synthetic-second variant of the public-contract rule',
        triggers: {
          keywords: ['export function'],
          scope: ['**/*.synth'],
        },
      },
    ],
  };
}

describe('buildDocumentationSurfacesInstantiated', () => {
  it('instantiation, web-node only — keyword fires in scope yields one verbatim row', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/api.ts'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['src/api.ts'],
      fileContents: {
        'src/api.ts': 'export function handler(): void {}\n',
      },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    const ids = rows.map((r) => `${r.stack}.${r.id}`);
    expect(ids).toContain('web-node.public_contract_completeness');
    expect(ids).toContain('web-node.comments_explain_why_not_what');

    const pc = rows.find((r) => r.id === 'public_contract_completeness');
    expect(pc).toBeTruthy();

    expect(pc!.templateText).toBe(DOC_PUBLIC_CONTRACT_TEMPLATE);
    expect(pc!.triggerEvidence.keywordsHit).toEqual(['export function']);
    expect(pc!.appliesToFiles).toEqual(['src/api.ts']);
  });

  it('instantiation — no in-scope file yields no documentation row', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };

    const sprintPlan: SprintPlan = { affectedFiles: ['docs/README.md'], criteria: [] };
    const worktree: WorktreeState = {
      files: ['docs/README.md'],
      fileContents: { 'docs/README.md': 'export function not actually code\n' },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    expect(rows).toEqual([]);
  });

  it('instantiation — keyword absent yields no row for the keyworded surface', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = { affectedFiles: ['src/internal.ts'], criteria: [] };
    const worktree: WorktreeState = {
      files: ['src/internal.ts'],

      fileContents: { 'src/internal.ts': 'const local = 1;\n' },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    const ids = rows.map((r) => r.id);

    expect(ids).not.toContain('public_contract_completeness');
    expect(ids).toContain('comments_explain_why_not_what');
  });

  it('cross-stack — two stacks with the same doc-surface id yield two distinct rows', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack(), secondStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/api.ts', 'data/blob.synth'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['src/api.ts', 'data/blob.synth'],
      fileContents: {
        'src/api.ts': 'export function a(): void {}\n',
        'data/blob.synth': 'export function b(): void {}\n',
      },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    const sameIdRows = rows.filter((r) => r.id === 'public_contract_completeness');
    expect(sameIdRows.length).toBe(2);
    const qualified = sameIdRows.map((r) => `${r.stack}.${r.id}`);
    expect(qualified).toContain('web-node.public_contract_completeness');
    expect(qualified).toContain('synthetic-second.public_contract_completeness');

    const allKeys = rows.map((r) => `${r.stack}.${r.id}`);
    const sortedKeys = [...allKeys].sort((a, b) => a.localeCompare(b));
    expect(allKeys).toEqual(sortedKeys);
  });

  it('polyglot cross-contamination — a doc surface from stack A never fires on a stack-B-only file', () => {

    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack(), secondStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = { affectedFiles: ['data/decoy.synth'], criteria: [] };
    const worktree: WorktreeState = {
      files: ['data/decoy.synth'],
      fileContents: { 'data/decoy.synth': 'export function b(): void {} // decoy\n' },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    const webNodeRows = rows.filter((r) => r.stack === 'web-node');
    expect(webNodeRows).toEqual([]);

    const syn = rows.find((r) => r.stack === 'synthetic-second');
    expect(syn).toBeTruthy();
    expect(syn!.appliesToFiles).toEqual(['data/decoy.synth']);
  });

  it('deterministic — same input yields byte-identical JSON across two calls', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [secondStack(), webNodeStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/api.ts', 'data/blob.synth'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['src/api.ts', 'data/blob.synth'],
      fileContents: {
        'src/api.ts': 'export function a(): void {}\n',
        'data/blob.synth': 'export function b(): void {}\n',
      },
    };

    const a = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const b = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('isKnownSurfaceId (suppress union existence-check)', () => {
  const snapshot: EvaluatorCoreSnapshot = {
    activeStacks: [webNodeStack()],
    mergedSplicePoints: {},
  };

  it('suppress — a real documentationSurfaces id is a known member of the union', () => {
    expect(isKnownSurfaceId(snapshot, 'web-node.public_contract_completeness')).toBe(true);
    expect(isKnownSurfaceId(snapshot, 'web-node.comments_explain_why_not_what')).toBe(true);
  });

  it('suppress — a real securitySurfaces id is STILL known (proves the check is the union, not just docs)', () => {
    expect(isKnownSurfaceId(snapshot, 'web-node.route_input_validation')).toBe(true);
  });

  it('suppress — an id in NEITHER set is unknown (routes to the non-aborting warning channel)', () => {
    expect(isKnownSurfaceId(snapshot, 'web-node.no_such_surface')).toBe(false);
  });

  it('suppress — an id qualified by an inactive stack is unknown', () => {
    expect(isKnownSurfaceId(snapshot, 'not-active.public_contract_completeness')).toBe(false);
  });

  it('suppress — a bare id with no <stack>. qualifier is unknown (never matched by bare id)', () => {
    expect(isKnownSurfaceId(snapshot, 'public_contract_completeness')).toBe(false);
  });

  it('suppress — drops the targeted doc criterion while the other doc criteria remain', () => {

    const sprintPlan: SprintPlan = { affectedFiles: ['src/api.ts'], criteria: [] };
    const worktree: WorktreeState = {
      files: ['src/api.ts'],
      fileContents: { 'src/api.ts': 'export function handler(): void {}\n' },
    };
    const suppress = ['web-node.comments_explain_why_not_what'];

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const kept = rows.filter((r) => !suppress.includes(`${r.stack}.${r.id}`));
    const keptIds = kept.map((r) => `${r.stack}.${r.id}`);

    expect(keptIds).not.toContain('web-node.comments_explain_why_not_what');
    expect(keptIds).toContain('web-node.public_contract_completeness');

    expect(isKnownSurfaceId(snapshot, suppress[0]!)).toBe(true);
  });
});

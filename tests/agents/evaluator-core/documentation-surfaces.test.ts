/**
 * Q5 Sprint 2 — documentation-surface instantiation tests.
 *
 * Exercises `buildDocumentationSurfacesInstantiated` and the union
 * `isKnownSurfaceId` existence-check as pure functions over typed data,
 * mirroring the security-surface coverage in `plan-builder.test.ts`. The
 * documentation family instantiates through the identical C1 protocol, so
 * these tests assert the same guarantees: verbatim template, scope ∩
 * stack-scope intersect, keyword gate, cross-stack `<stack>.<id>`
 * namespace (never deduped by bare id), and the polyglot
 * cross-contamination guard.
 *
 * Test naming is load-bearing: the discriminator greps for the labels
 * 'instantiation', 'cross-stack', 'polyglot', 'cross-contamination',
 * 'suppress', 'deterministic', 'web-node only'.
 */

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

// ---- Fixture helpers ----------------------------------------------------

/**
 * The `public_contract_completeness` template, authored verbatim here so
 * the verbatim-instantiation assertions compare against a fixed string
 * rather than re-reading the stack file (which would make the test pass
 * trivially even if instantiation mangled the template).
 */
const DOC_PUBLIC_CONTRACT_TEMPLATE =
  "Every exported function, class, or type documents each parameter's meaning, " +
  'failure modes, side effects, and invariants.';

const DOC_SCOPE_ONLY_TEMPLATE =
  'Every comment explains a constraint, invariant, or non-obvious decision and its rationale.';

function webNodeStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'web-node',
    scope: ['**/*.ts', '**/*.tsx'],
    // A security surface alongside the doc surfaces, so the union
    // existence-check has a real security id to find in the same stack.
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

// A second active stack that declares the SAME bare documentation-surface
// id as web-node, over a scope DISJOINT from web-node's `.ts` glob (it
// scopes `.synth` files only). The disjoint scope is what makes the
// cross-contamination guard testable: a `.synth` file is in this stack's
// scope but not web-node's, so web-node's surfaces must never match it
// even when it carries web-node's keyword.
function secondStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'synthetic-second',
    scope: ['**/*.synth'],
    documentationSurfaces: [
      {
        // Deliberately the SAME bare id as web-node's first doc surface.
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

// ---- Tests --------------------------------------------------------------

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

    // The keyword surface fires (export function) AND the scope-only
    // surface fires (any in-scope .ts) → two rows.
    const ids = rows.map((r) => `${r.stack}.${r.id}`);
    expect(ids).toContain('web-node.public_contract_completeness');
    expect(ids).toContain('web-node.comments_explain_why_not_what');

    const pc = rows.find((r) => r.id === 'public_contract_completeness');
    expect(pc).toBeTruthy();
    // Template is verbatim, byte-for-byte (no interpolation per C1).
    expect(pc!.templateText).toBe(DOC_PUBLIC_CONTRACT_TEMPLATE);
    expect(pc!.triggerEvidence.keywordsHit).toEqual(['export function']);
    expect(pc!.appliesToFiles).toEqual(['src/api.ts']);
  });

  it('instantiation — no in-scope file yields no documentation row', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };
    // A .md file is outside web-node's scope (**/*.ts, **/*.tsx).
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
      // No `export …` keyword present: the keyworded surface must NOT fire.
      fileContents: { 'src/internal.ts': 'const local = 1;\n' },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    const ids = rows.map((r) => r.id);
    // The keyworded surface is absent; the scope-only surface still fires
    // because the file is in scope (a scope-only surface needs no keyword).
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

    // Both same-id surfaces present, keyed by the qualified <stack>.<id> —
    // never deduplicated by the bare id `public_contract_completeness`.
    const sameIdRows = rows.filter((r) => r.id === 'public_contract_completeness');
    expect(sameIdRows.length).toBe(2);
    const qualified = sameIdRows.map((r) => `${r.stack}.${r.id}`);
    expect(qualified).toContain('web-node.public_contract_completeness');
    expect(qualified).toContain('synthetic-second.public_contract_completeness');

    // Output sorted by (stack, id): synthetic-second sorts before web-node.
    const allKeys = rows.map((r) => `${r.stack}.${r.id}`);
    const sortedKeys = [...allKeys].sort((a, b) => a.localeCompare(b));
    expect(allKeys).toEqual(sortedKeys);
  });

  it('polyglot cross-contamination — a doc surface from stack A never fires on a stack-B-only file', () => {
    // web-node's doc surfaces are scoped to .ts/.tsx; synthetic-second's to
    // **/*.synth (disjoint). Touch ONLY a `.synth` file that deliberately
    // carries web-node's `export function` keyword. web-node's surface must
    // emit NO row (the .synth file is outside web-node's stack scope), even
    // though the keyword is present — that is the guard. synthetic-second's
    // surface fires, since the file is in its scope.
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

    // Zero web-node rows: its surfaces never saw the out-of-scope file.
    const webNodeRows = rows.filter((r) => r.stack === 'web-node');
    expect(webNodeRows).toEqual([]);

    // synthetic-second's surface fired on its own in-scope file.
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
    // Model the suppress behaviour the proposer applies: instantiate, then
    // filter out any qualified id the user listed in suppressSurfaces. The
    // existence-check above governs whether that listing is a real drop or
    // an unknown-id warning; here we assert the drop itself.
    const sprintPlan: SprintPlan = { affectedFiles: ['src/api.ts'], criteria: [] };
    const worktree: WorktreeState = {
      files: ['src/api.ts'],
      fileContents: { 'src/api.ts': 'export function handler(): void {}\n' },
    };
    const suppress = ['web-node.comments_explain_why_not_what'];

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const kept = rows.filter((r) => !suppress.includes(`${r.stack}.${r.id}`));
    const keptIds = kept.map((r) => `${r.stack}.${r.id}`);

    // The suppressed criterion is gone; the other doc criterion remains.
    expect(keptIds).not.toContain('web-node.comments_explain_why_not_what');
    expect(keptIds).toContain('web-node.public_contract_completeness');
    // The suppression target was a real union member (a valid drop).
    expect(isKnownSurfaceId(snapshot, suppress[0]!)).toBe(true);
  });
});

/**
 * Documentation-surface instantiation suite — pins how a stack's declared
 * documentationSurfaces become concrete plan rows against a sprint's touched
 * files, and how the surface-id union is queried.
 *
 * buildDocumentationSurfacesInstantiated firing rules:
 * - a surface instantiates only when an in-scope touched file exists; the
 *   template text is carried VERBATIM (no interpolation) and triggerEvidence
 *   records which keywords/files matched.
 * - a keyword-gated surface (public_contract_completeness) fires only when its
 *   keyword appears in an in-scope file, while a scope-only surface
 *   (comments_explain_why_not_what) fires for any in-scope file regardless of
 *   keyword. So a file with no matching keyword yields the scope-only row but
 *   not the keyworded one.
 * - polyglot isolation: two stacks declaring the SAME bare surface id produce
 *   two DISTINCT rows keyed by `<stack>.<id>` (no dedup), and a surface from
 *   stack A never fires on a file that is only inside stack B's scope.
 * - output is sorted by qualified id and byte-identical across calls.
 *
 * isKnownSurfaceId (the suppress-list existence check) treats the
 * documentation and security surface ids as ONE namespace: a real doc id and a
 * real security id are both "known", an id in neither set is unknown (routing
 * to a non-aborting warning rather than an abort), an id qualified by an
 * inactive stack is unknown, and a bare id with no `<stack>.` qualifier is
 * never matched. The closing test shows a suppress entry drops exactly its
 * targeted doc criterion while the others survive.
 *
 * The DOC_*_TEMPLATE constants are the verbatim standard text; asserting
 * equality against them is what proves "no interpolation".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  buildDocumentationSurfacesInstantiated,
  isKnownSurfaceId,
} from '../../../src/agents/evaluator-core/index.js';
import type {
  DocumentationSurface,
  EvaluatorCoreSnapshot,
  SprintPlan,
  WorktreeState,
} from '../../../src/agents/evaluator-core/index.js';
import { verifyEvidenceBundle } from '../../../src/trace/evidence-bundle.js';
import type { ContractCriterionLike } from '../../../src/trace/evidence-bundle.js';

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

    // The file is in-scope but contains no `export ...` keyword: the
    // keyword-gated surface must NOT fire, yet the scope-only surface still does.
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
    // The decoy file is in stack-B (synth) scope but its content carries a
    // web-node keyword (`export function`); web-node's surface must still NOT
    // fire on it, because the file is outside web-node's scope.
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

// The qualified key the engine emits for the provenance surface; named once so
// the (a)/(b)/(c) cases and the per-criterion gate all key off the same string.
const PROVENANCE_QUALIFIED_ID = 'web-node.comments_cite_no_development_provenance';

// Read the provenance surface back out of the shipped web-node stack rather
// than re-stating its template here: the instantiation proof is "the engine
// carries the stack-declared template through verbatim", so the expected value
// must originate in the stack data, not a hand-copied literal that could drift
// from the stack and still pass. Parsing the front-matter is also what proves
// the surface is plain stack data the unchanged engine consumes.
function readWebNodeProvenanceSurface(): DocumentationSurface {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // tests/agents/evaluator-core -> repo root is three levels up.
  const repoRoot = path.resolve(here, '..', '..', '..');
  const raw = readFileSync(path.join(repoRoot, 'stacks', 'web-node.md'), 'utf8');

  // The stack file is a Markdown doc with a leading YAML front-matter block; the
  // surfaces live in that block, so we slice it out before parsing.
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) {
    throw new Error('web-node.md has no YAML front-matter block to read surfaces from');
  }
  const front = parseYaml(match[1]) as {
    documentationSurfaces?: DocumentationSurface[];
  };
  const surface = (front.documentationSurfaces ?? []).find(
    (s) => s.id === 'comments_cite_no_development_provenance',
  );
  if (surface === undefined) {
    throw new Error('web-node.md is missing the comments_cite_no_development_provenance surface');
  }
  return surface;
}

// Build a snapshot whose only stack is web-node carrying the real provenance
// surface read from the stack file — the engine sees exactly what /gan would.
function provenanceSnapshot(surface: DocumentationSurface): EvaluatorCoreSnapshot {
  return {
    activeStacks: [
      {
        name: 'web-node',
        scope: ['**/*.ts', '**/*.tsx'],
        documentationSurfaces: [surface],
      },
    ],
    mergedSplicePoints: {},
  };
}

describe('comments_cite_no_development_provenance — C1 instantiation end-to-end', () => {
  const surface = readWebNodeProvenanceSurface();

  it('(a) instantiates verbatim against a .ts affected file, keyed web-node.<id>', () => {
    const snapshot = provenanceSnapshot(surface);
    const sprintPlan: SprintPlan = { affectedFiles: ['src/feature.ts'], criteria: [] };
    // The surface has no keyword trigger, so file contents are irrelevant to
    // whether it fires — only scope matters; the worktree is supplied for parity
    // with how the builder is called in /gan, not because a keyword is needed.
    const worktree: WorktreeState = {
      files: ['src/feature.ts'],
      fileContents: { 'src/feature.ts': 'export function f(): void {}\n' },
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const row = rows.find((r) => `${r.stack}.${r.id}` === PROVENANCE_QUALIFIED_ID);

    expect(row).toBeTruthy();
    // Verbatim: equality against the template read from the stack, not a literal.
    expect(row!.templateText).toBe(surface.template);
    expect(row!.appliesToFiles).toEqual(['src/feature.ts']);
  });

  it('(a) also fires on a .tsx affected file', () => {
    const snapshot = provenanceSnapshot(surface);
    const sprintPlan: SprintPlan = { affectedFiles: ['src/component.tsx'], criteria: [] };
    const worktree: WorktreeState = { files: ['src/component.tsx'], fileContents: {} };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const keys = rows.map((r) => `${r.stack}.${r.id}`);

    expect(keys).toContain(PROVENANCE_QUALIFIED_ID);
  });

  it('(b) scope miss — a .md/.yml-only affected set does NOT fire it', () => {
    const snapshot = provenanceSnapshot(surface);
    // Markdown and YAML are deliberately outside the surface's
    // ["**/*.ts", "**/*.tsx"] scope: the built-in stack leaves markdown
    // provenance to the user's own prose (judging a user's README/changelog
    // references would over-reach), so the surface must not fire on a
    // docs/config-only diff.
    const sprintPlan: SprintPlan = {
      affectedFiles: ['docs/notes.md', '.github/workflows/test-doc-lint.yml'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['docs/notes.md', '.github/workflows/test-doc-lint.yml'],
      fileContents: {},
    };

    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);

    expect(rows).toEqual([]);
  });

  it('(c) isKnownSurfaceId recognises the new qualified id', () => {
    const snapshot = provenanceSnapshot(surface);
    expect(isKnownSurfaceId(snapshot, PROVENANCE_QUALIFIED_ID)).toBe(true);
  });

  it('(d) a below-threshold provenance verdict rides the real evidence-bundle gate, not a stand-in', () => {
    // Scoring (1–10 → pass/fail) is the LLM evaluator's judgment; the framework
    // has no deterministic score→verdict function to unit-test, exactly as for
    // every securitySurface criterion. What IS deterministic — and what the gate
    // actually consumes — is the evidence bundle: a below-threshold criterion is
    // recorded as verdict:'fail', and verifyEvidenceBundle is the real gate
    // machinery that schema-validates that failing verdict and joins it to the
    // sprint contract. This drives that real path instead of re-implementing
    // `score >= threshold` in the test.
    const snapshot = provenanceSnapshot(surface);
    const sprintPlan: SprintPlan = { affectedFiles: ['src/feature.ts'], criteria: [] };
    const worktree: WorktreeState = { files: ['src/feature.ts'], fileContents: {} };

    // The criterion must be instantiated for the gate to have anything to score;
    // proving (d) on a criterion that did not fire would be vacuous.
    const rows = buildDocumentationSurfacesInstantiated(snapshot, sprintPlan, worktree);
    const row = rows.find((r) => `${r.stack}.${r.id}` === PROVENANCE_QUALIFIED_ID);
    expect(row).toBeTruthy();
    const criterionName = `${row!.stack}.${row!.id}`;

    // The sprint contract carries the instantiated provenance criterion as the
    // join-key target.
    const contract: ContractCriterionLike[] = [{ name: criterionName }];

    // The evaluator's bundle for an attempt that scored provenance below its
    // threshold: the criterion is recorded as a failing verdict with the
    // evidence a fail requires. The bundle carries an evaluatorPromptDigest
    // because the v2 schema introduced by T5 requires it at root level; the
    // value is a 64-character lowercase hex stand-in (shape-canonical for
    // SHA-256 hex), since the fixture pins the verifier's behaviour, not the
    // bytes the orchestrator would have hashed at spawn.
    const failingBundle = {
      sprintNumber: 1,
      attemptLetter: 'A',
      evaluatorPromptDigest: 'a'.repeat(64),
      criteria: [
        {
          name: criterionName,
          verdict: 'fail',
          evidence: {
            traceEventRefs: [],
            reproductionCommand: 'rg -n "sprint|ticket" src/feature.ts',
            deltaFromContract: {
              expected: 'comments and user-facing strings cite no development-process artifact',
              observed: 'src/feature.ts carries an in-comment sprint reference',
            },
          },
        },
      ],
      verdictSummary: { totalCriteria: 1, passed: 0, failed: 1, blocked: 0, skipped: 0 },
    };

    // The real gate machinery accepts the failing verdict and joins it to the
    // contract: the provenance criterion genuinely participates in the gate, and
    // the bundle is not all-pass — which the orchestrator treats as a failed
    // attempt.
    const result = verifyEvidenceBundle(failingBundle, contract, []);
    expect(result.ok).toBe(true);
    expect(result.schemaValid).toBe(true);
    expect(failingBundle.criteria.some((c) => c.verdict === 'fail')).toBe(true);

    // And the gate is not a rubber stamp: a fail verdict stripped of its required
    // evidence is rejected by the same real machinery (a failing verdict cannot
    // be recorded without the reproduction command + expected/observed delta).
    const malformed = {
      ...failingBundle,
      criteria: [{ name: criterionName, verdict: 'fail', evidence: { traceEventRefs: [] } }],
    };
    const bad = verifyEvidenceBundle(malformed, contract, []);
    expect(bad.ok).toBe(false);
    expect(bad.failures.length).toBeGreaterThan(0);
  });
});

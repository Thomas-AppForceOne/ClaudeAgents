

import { describe, expect, it } from 'vitest';

import { buildEvaluatorPlan } from '../../../src/agents/evaluator-core/index.js';
import type {
  EvaluatorCoreSnapshot,
  SprintPlan,
  WorktreeState,
} from '../../../src/agents/evaluator-core/index.js';

function emptySnapshot(): EvaluatorCoreSnapshot {
  return { activeStacks: [], mergedSplicePoints: {} };
}

function genericStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'generic',
    scope: ['**/*'],
    secretsGlob: ['env'],
    // No auditCmd / buildCmd / testCmd / lintCmd / securitySurfaces.
    // The generic stack is intentionally minimal.
  };
}

function webNodeStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'web-node',
    scope: ['**/*.js', '**/*.ts', '**/*.tsx', 'package.json'],
    secretsGlob: ['ts', 'js'],
    auditCmd: {
      command: 'audit-tool --level=high',
      absenceSignal: 'blockingConcern',
    },
    buildCmd: 'run-build',
    testCmd: 'run-test',
    lintCmd: 'run-lint',
    securitySurfaces: [
      {
        id: 'route_input_validation',
        template:
          'Route handlers must validate untrusted input before passing to query / shell / fs APIs.',
        triggers: {
          scope: ['**/*.ts'],
          keywords: ['app.get(', 'req.query'],
        },
      },
    ],
  };
}

function syntheticStack(): EvaluatorCoreSnapshot['activeStacks'][number] {
  return {
    name: 'synthetic-second',
    scope: ['**/*.synth', '**/synthetic.toml'],
    secretsGlob: ['synth'],
    auditCmd: {
      command: 'synthetic-audit',
      absenceSignal: 'warning',
    },
    securitySurfaces: [
      {
        id: 'synth_marker',
        template: 'Synthetic markers must be reviewed.',
        triggers: {
          scope: ['**/*.synth'],
          keywords: ['SYNTHETIC_MARKER'],
        },
      },
    ],
  };
}

describe('buildEvaluatorPlan', () => {
  it('empty active set — returns a plan with empty arrays and an empty buildTestLint', () => {
    const snapshot = emptySnapshot();
    const sprintPlan: SprintPlan = { affectedFiles: [], criteria: [] };
    const worktree: WorktreeState = { files: [] };

    const plan = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    expect(plan.activeStacks).toEqual([]);
    expect(plan.secretsScans).toEqual([]);
    expect(plan.auditCommands).toEqual([]);
    expect(plan.buildTestLint).toEqual({});
    expect(plan.securitySurfacesInstantiated).toEqual([]);
    expect(plan.evaluatorAdditionalChecks).toEqual([]);
  });

  it('generic only — emits a single active stack, no surfaces, no commands', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [genericStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['notes.txt', '.env'],
      criteria: [{ id: 'C1', description: 'x' }],
    };
    const worktree: WorktreeState = { files: ['notes.txt', '.env'] };

    const plan = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    expect(plan.activeStacks).toEqual([{ name: 'generic', scope: ['**/*'] }]);
    expect(plan.auditCommands).toEqual([]);
    expect(plan.securitySurfacesInstantiated).toEqual([]);
    expect(plan.buildTestLint).toEqual({});

    expect(plan.secretsScans).toEqual([
      { stack: 'generic', extension: 'env', files: ['.env'] },
    ]);
  });

  it('web-node only — instantiates a security surface when a touched file matches scope and keyword', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/handler.ts', 'package.json'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['src/handler.ts', 'package.json'],
      fileContents: {
        'src/handler.ts': 'app.get("/users", (req, res) => res.json(req.query));\n',
        'package.json': '{"name":"x"}',
      },
    };

    const plan = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    expect(plan.activeStacks).toEqual([
      {
        name: 'web-node',
        scope: ['**/*.js', '**/*.ts', '**/*.tsx', 'package.json'],
      },
    ]);
    expect(plan.auditCommands).toEqual([
      {
        stack: 'web-node',
        command: 'audit-tool --level=high',
        absenceSignal: 'blockingConcern',
      },
    ]);
    expect(plan.buildTestLint).toEqual({
      buildCmd: 'run-build',
      testCmd: 'run-test',
      lintCmd: 'run-lint',
    });

    expect(plan.securitySurfacesInstantiated.length).toBe(1);
    const surface = plan.securitySurfacesInstantiated[0];
    expect(surface.stack).toBe('web-node');
    expect(surface.id).toBe('route_input_validation');
    expect(surface.appliesToFiles).toEqual(['src/handler.ts']);
    expect(surface.triggerEvidence.scopeMatched).toEqual(['src/handler.ts']);
    expect(surface.triggerEvidence.keywordsHit.sort()).toEqual(
      ['app.get(', 'req.query'].sort(),
    );

    expect(surface.templateText).toContain('Route handlers must validate');

    const tsScan = plan.secretsScans.find((s) => s.extension === 'ts');
    expect(tsScan).toBeTruthy();
    expect(tsScan!.files).toEqual(['src/handler.ts']);
  });

  it('polyglot — both stacks active, each contributes its own surfaces and audits', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack(), syntheticStack()],
      mergedSplicePoints: {
        'evaluator.additionalChecks': [
          { command: 'extra-typecheck', on_failure: 'blockingConcern', tier: 'project' },
        ],
      },
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/handler.ts', 'data/payload.synth'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['src/handler.ts', 'data/payload.synth', 'README.md'],
      fileContents: {
        'src/handler.ts': 'app.get("/x", (req) => req.query);\n',
        'data/payload.synth': '# SYNTHETIC_MARKER on this line\n',
      },
    };

    const plan = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    expect(plan.activeStacks.map((s) => s.name)).toEqual(['synthetic-second', 'web-node']);

    expect(plan.auditCommands.map((a) => a.stack)).toEqual([
      'synthetic-second',
      'web-node',
    ]);

    const ids = plan.securitySurfacesInstantiated.map((s) => `${s.stack}.${s.id}`);
    expect(ids).toContain('web-node.route_input_validation');
    expect(ids).toContain('synthetic-second.synth_marker');

    expect(plan.evaluatorAdditionalChecks).toEqual([
      { command: 'extra-typecheck', on_failure: 'blockingConcern', tier: 'project' },
    ]);
  });

  it('cross-contamination — stack A surfaces never apply to files only inside stack B scope', () => {

    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [webNodeStack(), syntheticStack()],
      mergedSplicePoints: {},
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['data/decoy.synth', 'src/decoy.ts'],
      criteria: [],
    };
    const worktree: WorktreeState = {
      files: ['data/decoy.synth', 'src/decoy.ts'],
      fileContents: {

        'data/decoy.synth': 'app.get("/decoy", () => req.query) // not a web handler\n',

        'src/decoy.ts': '// SYNTHETIC_MARKER decoy in TS file\n',
      },
    };

    const plan = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    const wn = plan.securitySurfacesInstantiated.find(
      (s) => s.stack === 'web-node' && s.id === 'route_input_validation',
    );
    if (wn !== undefined) {
      expect(wn.appliesToFiles).not.toContain('data/decoy.synth');

      expect(wn.triggerEvidence.scopeMatched).not.toContain('data/decoy.synth');
    }

    const syn = plan.securitySurfacesInstantiated.find(
      (s) => s.stack === 'synthetic-second' && s.id === 'synth_marker',
    );
    if (syn !== undefined) {
      expect(syn.appliesToFiles).not.toContain('src/decoy.ts');
      expect(syn.triggerEvidence.scopeMatched).not.toContain('src/decoy.ts');
    }

    for (const row of plan.secretsScans) {
      if (row.stack === 'web-node') {
        expect(row.files.every((f) => !f.endsWith('.synth'))).toBe(true);
      }
      if (row.stack === 'synthetic-second') {
        expect(row.files.every((f) => !f.endsWith('.ts'))).toBe(true);
      }
    }

    const wnAudit = plan.auditCommands.find((a) => a.stack === 'web-node');
    const synAudit = plan.auditCommands.find((a) => a.stack === 'synthetic-second');
    if (wnAudit) expect(wnAudit.command).toBe('audit-tool --level=high');
    if (synAudit) expect(synAudit.command).toBe('synthetic-audit');
  });

  it('deterministic — same input yields byte-identical JSON across two calls', () => {
    const snapshot: EvaluatorCoreSnapshot = {
      activeStacks: [

        webNodeStack(),
        syntheticStack(),
        genericStack(),
      ],
      mergedSplicePoints: {
        'evaluator.additionalChecks': [
          { command: 'extra-typecheck', on_failure: 'warning', tier: 'project' },
          { command: 'extra-format', on_failure: 'warning', tier: 'user' },
        ],
      },
    };
    const sprintPlan: SprintPlan = {
      affectedFiles: ['src/handler.ts', 'data/payload.synth', '.env'],
      criteria: [
        { id: 'B', description: 'second' },
        { id: 'A', description: 'first' },
      ],
    };
    const worktree: WorktreeState = {
      files: ['src/handler.ts', 'data/payload.synth', '.env', 'README.md'],
      fileContents: {
        'src/handler.ts': 'app.get("/u", (req) => req.query);\n',
        'data/payload.synth': '# SYNTHETIC_MARKER\n',
      },
    };

    const a = buildEvaluatorPlan(snapshot, sprintPlan, worktree);
    const b = buildEvaluatorPlan(snapshot, sprintPlan, worktree);

    expect(a).toEqual(b);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    expect(a.activeStacks.map((s) => s.name)).toEqual([
      'generic',
      'synthetic-second',
      'web-node',
    ]);

    const keys = a.secretsScans.map((r) => `${r.stack}.${r.extension}`);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
  });
});

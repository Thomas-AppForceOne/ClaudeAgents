// Exercises cascadeOverlays — the C4 merge that folds the three overlay tiers
// (default < user < project) into one effective view. The suite pins the
// per-shape merge rules that the rest of the system relies on:
//   - scalars: highest present tier wins;
//   - string lists: lower-tier-first union, deduped by exact string;
//   - keyed object lists (by name/command): union that preserves first-seen
//     order while letting a higher tier override a matching key in place;
//   - maps: deep-merged, higher tier wins per key;
//   - the discardInherited wrapper (block- and field-level) for explicitly
//     dropping inherited values, with field-level precedence over block-level;
//   - malformed wrappers surfacing as MalformedInput rather than merging.
// These ordering/precedence guarantees are the contract callers depend on, so
// each case documents the exact expected shape rather than just "it merges".
import { describe, expect, it } from 'vitest';

import { cascadeOverlays } from '../../../src/config-server/resolution/cascade.js';

describe('cascadeOverlays — C4 cascade mechanics', () => {
  describe('scalar override', () => {
    it('higher tier wins (project beats default)', () => {
      const result = cascadeOverlays({
        default: { runner: { thresholdOverride: 5 } },
        user: null,
        project: { runner: { thresholdOverride: 8 } },
      });
      expect(result.merged).toEqual({ runner: { thresholdOverride: 8 } });
      expect(result.discarded).toEqual([]);
      expect(result.issues).toEqual([]);
    });

    it('user beats default when project absent', () => {
      const result = cascadeOverlays({
        default: { runner: { thresholdOverride: 5 } },
        user: { runner: { thresholdOverride: 7 } },
        project: null,
      });
      expect(result.merged).toEqual({ runner: { thresholdOverride: 7 } });
    });

    it('project beats user beats default', () => {
      const result = cascadeOverlays({
        default: { runner: { thresholdOverride: 5 } },
        user: { runner: { thresholdOverride: 7 } },
        project: { runner: { thresholdOverride: 9 } },
      });
      expect(result.merged).toEqual({ runner: { thresholdOverride: 9 } });
    });
  });

  describe('list union by string (generator.additionalRules)', () => {
    it('lower-tier first, higher-tier appended, dedup by exact string', () => {
      const result = cascadeOverlays({
        default: { generator: { additionalRules: ['rule-a'] } },
        user: { generator: { additionalRules: ['rule-b', 'rule-a'] } },
        project: { generator: { additionalRules: ['rule-c'] } },
      });
      expect(result.merged).toEqual({
        generator: { additionalRules: ['rule-a', 'rule-b', 'rule-c'] },
      });
    });
  });

  describe('list union by key (proposer.additionalCriteria)', () => {
    it("worked rule: [A,B,C] + [X,B',Y] -> [A,B',C,X,Y]", () => {
      const lower = [
        { name: 'A', description: 'a', threshold: 1 },
        { name: 'B', description: 'b', threshold: 2 },
        { name: 'C', description: 'c', threshold: 3 },
      ];
      const higher = [
        { name: 'X', description: 'x', threshold: 9 },
        { name: 'B', description: 'b-prime', threshold: 8 }, // override
        { name: 'Y', description: 'y', threshold: 7 },
      ];
      const result = cascadeOverlays({
        default: null,
        user: { proposer: { additionalCriteria: lower } },
        project: { proposer: { additionalCriteria: higher } },
      });
      const out = (result.merged.proposer as Record<string, unknown>).additionalCriteria as Array<
        Record<string, unknown>
      >;
      // Order is lower-tier first (A,B,C) then higher-tier newcomers (X,Y); the
      // shared key B keeps its original slot (index 1) rather than moving to
      // the end, even though its contents are replaced below.
      expect(out.map((o) => o.name)).toEqual(['A', 'B', 'C', 'X', 'Y']);

      // The in-place override: B's value is the higher tier's (b-prime/8).
      expect(out[1]).toEqual({ name: 'B', description: 'b-prime', threshold: 8 });
    });
  });

  describe('list union by command (evaluator.additionalChecks)', () => {
    it('preserves execution order with duplicate-key positioning', () => {
      const result = cascadeOverlays({
        default: null,
        user: {
          evaluator: {
            additionalChecks: [
              { command: './bin/check-A', on_failure: 'warning' },
              { command: './bin/check-B', on_failure: 'warning' },
              { command: './bin/check-C', on_failure: 'warning' },
            ],
          },
        },
        project: {
          evaluator: {
            additionalChecks: [
              { command: './bin/check-B', on_failure: 'blockingConcern' },
              { command: './bin/check-D', on_failure: 'warning' },
            ],
          },
        },
      });
      const checks = (result.merged.evaluator as Record<string, unknown>).additionalChecks as Array<
        Record<string, unknown>
      >;
      // Keyed by command: A,B,C from user, then D appended from project; the
      // shared check-B holds its original index-1 slot but takes the project's
      // on_failure value. Execution order is therefore stable across tiers.
      expect(checks.map((c) => c.command)).toEqual([
        './bin/check-A',
        './bin/check-B',
        './bin/check-C',
        './bin/check-D',
      ]);
      expect(checks[1].on_failure).toBe('blockingConcern');
    });
  });

  describe('discardInherited — block-level', () => {
    it('drops upstream block entirely; higher tier value replaces', () => {
      const result = cascadeOverlays({
        default: null,
        user: {
          stack: { override: ['user-stack'] },
        },
        project: {
          stack: {
            discardInherited: true,
            override: ['project-stack'],
          },
        },
      });
      expect((result.merged.stack as Record<string, unknown>).override).toEqual(['project-stack']);

      expect(result.discarded).toContain('stack.override');
    });

    it('block-level true with no replacement falls back to bare default', () => {
      // discardInherited drops the user's runner block but supplies no
      // replacement value, so the field disappears entirely (empty merged) and
      // the dropped path is reported in `discarded`.
      const result = cascadeOverlays({
        default: null,
        user: { runner: { thresholdOverride: 7 } },
        project: { runner: { discardInherited: true } },
      });

      expect(result.merged).toEqual({});
      expect(result.discarded).toContain('runner.thresholdOverride');
    });
  });

  describe('discardInherited — field-level', () => {
    it('field-level discard with value replaces only that field', () => {
      const result = cascadeOverlays({
        default: null,
        user: {
          generator: { additionalRules: ['user-rule-1', 'user-rule-2'] },
        },
        project: {
          generator: {
            additionalRules: { discardInherited: true, value: ['project-rule'] },
          },
        },
      });
      expect((result.merged.generator as Record<string, unknown>).additionalRules).toEqual([
        'project-rule',
      ]);
      expect(result.discarded).toContain('generator.additionalRules');
    });

    it('field-level discard without value resets to bare default', () => {
      const result = cascadeOverlays({
        default: null,
        user: {
          generator: { additionalRules: ['user-rule'] },
        },
        project: {
          generator: { additionalRules: { discardInherited: true } },
        },
      });

      expect((result.merged.generator as Record<string, unknown>).additionalRules).toEqual([]);
      expect(result.discarded).toContain('generator.additionalRules');
    });

    it('field-level wins over block-level when both set', () => {
      // The block says discard, but the field explicitly opts back in
      // (discardInherited: false), so the more specific field-level directive
      // wins: the user's rule is kept and the project's rule is unioned on top.
      const result = cascadeOverlays({
        default: null,
        user: {
          generator: { additionalRules: ['user-rule'] },
        },
        project: {
          generator: {
            discardInherited: true,
            additionalRules: { discardInherited: false, value: ['project-rule'] },
          },
        },
      });

      expect((result.merged.generator as Record<string, unknown>).additionalRules).toEqual([
        'user-rule',
        'project-rule',
      ]);
    });
  });

  describe('unknown wrapper rejection', () => {
    it('rejects { discardInherited, value, extra } as MalformedInput', () => {
      // A discard wrapper may only carry discardInherited + value; the stray
      // `extra` key makes the wrapper malformed. It surfaces as an issue
      // (naming the offending key) and the merge fails closed to empty rather
      // than guessing intent.
      const result = cascadeOverlays({
        default: null,
        user: null,
        project: {
          generator: {
            additionalRules: { discardInherited: true, value: [], extra: 'bad' },
          },
        },
      });
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('MalformedInput');
      expect(issue.message).toContain('extra');

      expect(result.merged).toEqual({});
    });
  });

  describe('deep merge (stack.cacheEnvOverride)', () => {
    it('merges per-stack maps; project keys win', () => {
      const result = cascadeOverlays({
        default: null,
        user: {
          stack: {
            cacheEnvOverride: {
              gradle: { GRADLE_USER_HOME: '/user/path' },
              other: { X: 'user' },
            },
          },
        },
        project: {
          stack: {
            cacheEnvOverride: {
              gradle: { GRADLE_USER_HOME: '/project/path', EXTRA: 'value' },
              webnode: { PNPM_HOME: '/project/pnpm' },
            },
          },
        },
      });
      const merged = (result.merged.stack as Record<string, unknown>).cacheEnvOverride as Record<
        string,
        Record<string, string>
      >;
      expect(merged.gradle.GRADLE_USER_HOME).toBe('/project/path');
      expect(merged.gradle.EXTRA).toBe('value');
      expect(merged.other.X).toBe('user');
      expect(merged.webnode.PNPM_HOME).toBe('/project/pnpm');
    });
  });

  describe('empty / absent tier handling', () => {
    it('three nulls produce an empty merged view', () => {
      const result = cascadeOverlays({ default: null, user: null, project: null });
      expect(result.merged).toEqual({});
      expect(result.discarded).toEqual([]);
      expect(result.issues).toEqual([]);
    });

    it('no override anywhere → field omitted from merged view', () => {
      // Present-but-empty tiers (distinct from null) still produce an empty
      // merged view: a field absent everywhere is simply omitted, never seeded.
      const result = cascadeOverlays({
        default: {},
        user: {},
        project: {},
      });
      expect(result.merged).toEqual({});
    });
  });

  describe('safety.* splice points', () => {
    it('safety.sprintBudget and safety.oscillationDetection scalar-override (highest tier wins)', () => {
      const result = cascadeOverlays({
        default: { safety: { sprintBudget: 12, oscillationDetection: true } },
        user: null,
        project: { safety: { sprintBudget: 20, oscillationDetection: false } },
      });
      expect(result.merged).toEqual({
        safety: { sprintBudget: 20, oscillationDetection: false },
      });
    });

    it('safety.attemptCeilings merges per-role across tiers, not wholesale replace', () => {
      // The project sets only gan-generator; the user's gan-contract-proposer
      // survives because merge-role-map merges per key rather than replacing the
      // whole map. The shared key takes the higher (project) tier's value.
      const result = cascadeOverlays({
        default: null,
        user: { safety: { attemptCeilings: { 'gan-contract-proposer': 4, 'gan-generator': 4 } } },
        project: { safety: { attemptCeilings: { 'gan-generator': 5 } } },
      });
      const ceilings = (result.merged.safety as Record<string, unknown>).attemptCeilings as Record<
        string,
        number
      >;
      expect(ceilings['gan-contract-proposer']).toBe(4);
      expect(ceilings['gan-generator']).toBe(5);
    });

    it('absent safety.* fields are omitted; no hollow safety block', () => {
      // Additive guarantee: the new fields must not change the empty-overlay
      // shape. With no safety anywhere the block is pruned entirely.
      const result = cascadeOverlays({
        default: { generator: { additionalRules: ['r'] } },
        user: null,
        project: null,
      });
      expect(result.merged.safety).toBeUndefined();
    });

    it('a __proto__-named ceiling key cannot pollute or shadow a real role', () => {
      const before = ({} as Record<string, unknown>)['polluted'];
      const result = cascadeOverlays({
        default: null,
        user: null,
        project: {
          safety: {
            attemptCeilings: {
              ['__proto__' as string]: 99,
              'gan-generator': 5,
            } as Record<string, number>,
          },
        },
      });
      expect(({} as Record<string, unknown>)['polluted']).toBe(before);
      expect(Object.prototype).not.toHaveProperty('polluted');
      const ceilings = (result.merged.safety as Record<string, unknown>).attemptCeilings as Record<
        string,
        number
      >;
      expect(ceilings['gan-generator']).toBe(5);
      expect(Object.prototype.hasOwnProperty.call(ceilings, '__proto__')).toBe(false);
    });
  });
});

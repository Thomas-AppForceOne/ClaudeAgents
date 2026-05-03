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
      expect(out.map((o) => o.name)).toEqual(['A', 'B', 'C', 'X', 'Y']);
      // The B' override carries the higher tier's content (b-prime) at B's slot.
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
      // The block-level discard records discardedness for every splice point
      // in `stack`.
      expect(result.discarded).toContain('stack.override');
    });

    it('block-level true with no replacement falls back to bare default', () => {
      const result = cascadeOverlays({
        default: null,
        user: { runner: { thresholdOverride: 7 } },
        project: { runner: { discardInherited: true } },
      });
      // Bare default for thresholdOverride is `undefined` per C3 — the
      // field is omitted from the merged view; runner block becomes empty
      // and is stripped.
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
      // Bare default for additionalRules is [].
      expect((result.merged.generator as Record<string, unknown>).additionalRules).toEqual([]);
      expect(result.discarded).toContain('generator.additionalRules');
    });

    it('field-level wins over block-level when both set', () => {
      // The block declares discardInherited: true which would normally
      // drop `additionalRules` AND `additionalChecks` upstream contributions.
      // But field-level `additionalRules.discardInherited: false` overrides
      // for that one field — preserving its merge semantics.
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
      // Because the field-level says discardInherited: false, the user's
      // 'user-rule' is preserved and 'project-rule' appends.
      expect((result.merged.generator as Record<string, unknown>).additionalRules).toEqual([
        'user-rule',
        'project-rule',
      ]);
    });
  });

  describe('unknown wrapper rejection', () => {
    it('rejects { discardInherited, value, extra } as MalformedInput', () => {
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
      // Hard error: the cascade does not produce a merged view for this run.
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
      const result = cascadeOverlays({
        default: {},
        user: {},
        project: {},
      });
      expect(result.merged).toEqual({});
    });
  });
});

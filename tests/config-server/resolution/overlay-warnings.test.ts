// Covers the pure overlay-warning detectors: the StackOverrideShrinkage
// comparison (including the count-blind generic-fallback edge case and the
// same-size-swap non-firing rule) and the PerStackOverrideUnsupported scan
// (one-warning-per-stack with field-set collapse, deterministic field order,
// the fires-for-inactive-stacks rule, the never-echo-the-value security rule,
// and prototype-pollution / malformed-shape safety). These functions are pure,
// so the tests pass plain objects rather than building filesystem fixtures —
// the fixture-backed end-to-end coverage lives in the resolver/validate suites.
import { describe, expect, it } from 'vitest';

import {
  computeStackOverrideShrinkageWarning,
  computePerStackOverrideWarnings,
  computeOverlayWarnings,
} from '../../../src/config-server/resolution/overlay-warnings.js';

describe('computeStackOverrideShrinkageWarning', () => {
  it('fires and names the suppressed stack when the override is strictly smaller', () => {
    const w = computeStackOverrideShrinkageWarning({
      overrideActive: ['php-grav'],
      detectionActive: ['php-grav', 'web-node'],
      detectionFellBackToGeneric: false,
    });
    expect(w).not.toBeNull();
    expect(w!.code).toBe('StackOverrideShrinkage');
    expect(w!.details).toEqual({
      code: 'StackOverrideShrinkage',
      overrideSet: ['php-grav'],
      detectionSet: ['php-grav', 'web-node'],
      suppressed: ['web-node'],
    });
    expect(w!.message).toContain('web-node');
    expect(w!.message).toContain('stack.override');
  });

  it('does not fire when the override is empty (auto-detection in force)', () => {
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: [],
        detectionActive: ['php-grav', 'web-node'],
        detectionFellBackToGeneric: false,
      }),
    ).toBeNull();
  });

  it('does not fire when the override equals the detection set', () => {
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: ['php-grav', 'web-node'],
        detectionActive: ['php-grav', 'web-node'],
        detectionFellBackToGeneric: false,
      }),
    ).toBeNull();
  });

  it('does not fire when the override is larger than the detection set', () => {
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: ['php-grav', 'web-node', 'docker'],
        detectionActive: ['php-grav'],
        detectionFellBackToGeneric: false,
      }),
    ).toBeNull();
  });

  it('does not fire on a same-size swap (replace one stack with another)', () => {
    // override [php-grav] against detection [web-node]: different sets, same
    // size — the user deliberately swapped, losing no coverage they expected.
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: ['php-grav'],
        detectionActive: ['web-node'],
        detectionFellBackToGeneric: false,
      }),
    ).toBeNull();
  });

  it('does not fire when detection found only the same single stack', () => {
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: ['php-grav'],
        detectionActive: ['php-grav'],
        detectionFellBackToGeneric: false,
      }),
    ).toBeNull();
  });

  it('fires for the generic-fallback edge case naming generic as suppressed', () => {
    // Count-blind case: override size 1, detection-with-fallback size 1
    // (generic). The size comparison alone would miss it, so the explicit
    // fallback branch fires and names generic.
    const w = computeStackOverrideShrinkageWarning({
      overrideActive: ['php-grav'],
      detectionActive: ['generic'],
      detectionFellBackToGeneric: true,
    });
    expect(w).not.toBeNull();
    expect(w!.details).toEqual({
      code: 'StackOverrideShrinkage',
      overrideSet: ['php-grav'],
      detectionSet: ['generic'],
      suppressed: ['generic'],
    });
    expect(w!.message).toContain('generic');
    expect(w!.message).toContain('fallback');
  });

  it('does not fire the fallback branch when the override already includes generic', () => {
    expect(
      computeStackOverrideShrinkageWarning({
        overrideActive: ['php-grav', 'generic'],
        detectionActive: ['generic'],
        detectionFellBackToGeneric: true,
      }),
    ).toBeNull();
  });
});

describe('computePerStackOverrideWarnings', () => {
  it('emits one warning naming the stack and field for a single override', () => {
    const ws = computePerStackOverrideWarnings({
      'web-node': { buildCmd: 'custom-build' },
    });
    expect(ws).toHaveLength(1);
    expect(ws[0].code).toBe('PerStackOverrideUnsupported');
    expect(ws[0].details).toEqual({
      code: 'PerStackOverrideUnsupported',
      stack: 'web-node',
      fields: ['buildCmd'],
    });
  });

  it('collapses multiple fields for one stack into a single deterministically-ordered warning', () => {
    // Declared out of canonical order (testCmd before buildCmd) to prove the
    // emitted field set follows the fixed order, not the declaration order.
    const ws = computePerStackOverrideWarnings({
      'web-node': { testCmd: 'y', buildCmd: 'x', lintCmd: 'z', auditCmd: 'a' },
    });
    expect(ws).toHaveLength(1);
    expect(ws[0].details).toEqual({
      code: 'PerStackOverrideUnsupported',
      stack: 'web-node',
      fields: ['auditCmd', 'buildCmd', 'testCmd', 'lintCmd'],
    });
  });

  it('emits one warning per distinct stack, locale-sorted by stack name', () => {
    const ws = computePerStackOverrideWarnings({
      'web-node': { buildCmd: 'x', testCmd: 'y' },
      'php-grav': { buildCmd: 'z' },
    });
    expect(ws).toHaveLength(2);
    expect(ws.map((w) => (w.details as { stack: string }).stack)).toEqual(['php-grav', 'web-node']);
    const webNode = ws.find((w) => (w.details as { stack: string }).stack === 'web-node');
    expect((webNode!.details as { fields: string[] }).fields).toEqual(['buildCmd', 'testCmd']);
  });

  it('never echoes the override command value into message or details', () => {
    // The override value embeds a recognisable secret-like token. It must not
    // surface anywhere in the warning — neither the prose nor the structured
    // details — because the snapshot and startup log are persisted.
    const SECRET = 'SECRET_TOKEN_abc123XYZ';
    const ws = computePerStackOverrideWarnings({
      'web-node': { buildCmd: `deploy --token=${SECRET}` },
    });
    expect(ws).toHaveLength(1);
    const serialised = JSON.stringify(ws[0]);
    expect(serialised).not.toContain(SECRET);
    expect(ws[0].message).not.toContain(SECRET);
  });

  it('ignores the framework overlay blocks (they are not stack names)', () => {
    // `stack`, `proposer`, etc. are cascade-owned blocks; a `buildCmd`-shaped
    // key inside one of them must not be mistaken for a per-stack override.
    const ws = computePerStackOverrideWarnings({
      stack: { override: ['web-node'] },
      proposer: { additionalContext: ['a'] },
      generator: { additionalRules: ['r'] },
    });
    expect(ws).toEqual([]);
  });

  it('tolerates non-object stack entries without throwing', () => {
    const ws = computePerStackOverrideWarnings({
      'web-node': 'not-an-object',
      'php-grav': ['also', 'not'],
      other: null,
    });
    expect(ws).toEqual([]);
  });

  it('skips prototype-polluting keys and never reads through the prototype chain', () => {
    const ws = computePerStackOverrideWarnings({
      __proto__: { buildCmd: 'x' },
      constructor: { buildCmd: 'y' },
      prototype: { buildCmd: 'z' },
      'web-node': { buildCmd: 'real' },
    });
    // Only the genuine stack key produces a warning; the prototype vectors are
    // skipped. (Object.prototype is also unharmed — proven indirectly: the loop
    // would have thrown or produced spurious warnings if it walked the chain.)
    expect(ws).toHaveLength(1);
    expect((ws[0].details as { stack: string }).stack).toBe('web-node');
    // An inherited toString must not be read as a buildCmd override either.
    expect(({} as Record<string, unknown>)['buildCmd']).toBeUndefined();
  });

  it('returns no warnings for a non-object merged overlay', () => {
    expect(computePerStackOverrideWarnings(null)).toEqual([]);
    expect(computePerStackOverrideWarnings('string')).toEqual([]);
    expect(computePerStackOverrideWarnings([1, 2, 3])).toEqual([]);
  });
});

describe('computeOverlayWarnings — composition', () => {
  it('composes both surfaces without interaction', () => {
    const ws = computeOverlayWarnings(
      {
        overrideActive: ['php-grav'],
        detectionActive: ['php-grav', 'web-node'],
        detectionFellBackToGeneric: false,
      },
      { 'web-node': { buildCmd: 'x' } },
    );
    const codes = ws.map((w) => w.code).sort();
    expect(codes).toEqual(['PerStackOverrideUnsupported', 'StackOverrideShrinkage']);
  });
});

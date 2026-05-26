// Covers the pure overlay-warning detector: the StackOverrideShrinkage
// comparison (including the count-blind generic-fallback edge case and the
// same-size-swap non-firing rule) and the computeOverlayWarnings composition
// wrapper. These functions are pure, so the tests pass plain objects rather than
// building filesystem fixtures — the fixture-backed end-to-end coverage lives in
// the resolver/validate suites.
import { describe, expect, it } from 'vitest';

import {
  computeStackOverrideShrinkageWarning,
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

describe('computeOverlayWarnings — composition', () => {
  it('returns the shrinkage warning when coverage was lost', () => {
    const ws = computeOverlayWarnings({
      overrideActive: ['php-grav'],
      detectionActive: ['php-grav', 'web-node'],
      detectionFellBackToGeneric: false,
    });
    expect(ws.map((w) => w.code)).toEqual(['StackOverrideShrinkage']);
  });

  it('returns an empty list when no coverage was lost', () => {
    const ws = computeOverlayWarnings({
      overrideActive: ['php-grav', 'web-node'],
      detectionActive: ['php-grav', 'web-node'],
      detectionFellBackToGeneric: false,
    });
    expect(ws).toEqual([]);
  });
});

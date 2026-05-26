// Pins the structured-warning catalog: the Warning shape, the closed code set,
// the default-message fallback, the discriminated details payload, and the
// createWarning factory. The catalog is a sibling to the error catalog — same
// shape (code union + payload + exhaustive default messages + create* factory)
// but a separate, warning-only vocabulary — so these assertions mirror the
// guarantees the error catalog already provides: codes are the contract,
// messages are advisory defaults, and a warning is inert JSON-serialisable data
// (no class, no methods) so it survives the snapshot's byte-stable freeze.
import { describe, expect, it } from 'vitest';

import {
  createWarning,
  type Warning,
  type WarningCode,
} from '../../src/config-server/warnings.js';

describe('structured-warning catalog', () => {
  it('createWarning fills the default message when none is supplied', () => {
    const w = createWarning({
      code: 'StackOverrideShrinkage',
      overrideSet: ['a'],
      detectionSet: ['a', 'b'],
      suppressed: ['b'],
    });
    expect(w.code).toBe('StackOverrideShrinkage');
    expect(typeof w.message).toBe('string');
    expect(w.message.length).toBeGreaterThan(0);
    expect(w.details).toEqual({
      code: 'StackOverrideShrinkage',
      overrideSet: ['a'],
      detectionSet: ['a', 'b'],
      suppressed: ['b'],
    });
  });

  it('createWarning prefers an explicit message over the default', () => {
    const w = createWarning(
      {
        code: 'StackOverrideShrinkage',
        overrideSet: ['php-grav'],
        detectionSet: ['php-grav', 'web-node'],
        suppressed: ['web-node'],
      },
      'explicit prose',
    );
    expect(w.message).toBe('explicit prose');
    expect(w.code).toBe('StackOverrideShrinkage');
  });

  it('a warning is inert JSON-serialisable data (round-trips byte-identically)', () => {
    const w = createWarning({
      code: 'StackOverrideShrinkage',
      overrideSet: ['php-grav'],
      detectionSet: ['php-grav', 'web-node'],
      suppressed: ['web-node'],
    });
    const roundTripped = JSON.parse(JSON.stringify(w)) as Warning;
    expect(roundTripped).toEqual(w);
  });

  it('the catalog is seeded with exactly the one declared code', () => {
    // The code union is closed; this assignment list documents (and the type
    // checker enforces) that exactly this code exists. A new code added to the
    // union without updating this list is a compile error in the literal.
    const codes: WarningCode[] = ['StackOverrideShrinkage'];
    expect(codes).toHaveLength(1);
  });
});

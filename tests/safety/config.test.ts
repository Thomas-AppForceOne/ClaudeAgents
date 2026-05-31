// Unit tests for the pure effective-safety-config resolver:
// resolveEffectiveSafetyConfig folds the seed defaults, the merged overlay's
// safety.* block, and the one-off runtime flags into the EffectiveSafetyConfig
// the orchestrator feeds into the attempt-start checks. Each behaviour is a
// separately-asserted case so a partial implementation (e.g. one that misses
// the flag-beats-overlay precedence, the n × roleCount + 4 arithmetic, or the
// uniform-ceiling-over-every-role rule) cannot pass by satisfying the others:
//   - empty/absent overlay+flags resolves to the seed defaults;
//   - safety.attemptCeilings.gan-generator: 5 ⇒ effective gan-generator 5 while
//     gan-contract-proposer keeps its seed 3 (unspecified role not dropped);
//   - safety.sprintBudget overrides the default 12;
//   - safety.oscillationDetection false ⇒ false; absent/true ⇒ true;
//   - --max-attempts=n ⇒ uniform ceiling n on EVERY multi-attempt role AND
//     sprintBudget = n × roleCount + 4 (roleCount = 2 here);
//   - --max-attempts beats a conflicting overlay (ceiling AND budget come from
//     the flag);
//   - the effective-ceiling map resists prototype pollution.
import { describe, expect, it } from 'vitest';

import { DEFAULT_ATTEMPT_CEILINGS } from '../../src/safety/loop-detection.js';
import { DEFAULT_SPRINT_BUDGET } from '../../src/safety/sprint-budget.js';
import {
  resolveEffectiveSafetyConfig,
  readSafetyOverlayBlock,
  DEFAULT_RENEGOTIATION_CAP,
  MAX_ATTEMPTS_BUDGET_HEADROOM,
} from '../../src/safety/config.js';

describe('resolveEffectiveSafetyConfig — defaults', () => {
  it('empty input resolves to the seed defaults', () => {
    const eff = resolveEffectiveSafetyConfig({});
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    expect(eff.attemptCeilings).toEqual({ ...DEFAULT_ATTEMPT_CEILINGS });
    expect(eff.sprintBudget).toBe(DEFAULT_SPRINT_BUDGET);
    expect(eff.sprintBudget).toBe(12);
    expect(eff.oscillationDetection).toBe(true);
  });

  it('an overlay omitting all three safety fields resolves to the defaults', () => {
    const eff = resolveEffectiveSafetyConfig({ overlay: {} });
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    expect(eff.sprintBudget).toBe(12);
    expect(eff.oscillationDetection).toBe(true);
  });
});

describe('resolveEffectiveSafetyConfig — overlay overrides', () => {
  it('safety.attemptCeilings.gan-generator: 5 raises gan-generator to 5; proposer keeps seed 3', () => {
    const eff = resolveEffectiveSafetyConfig({
      overlay: { attemptCeilings: { 'gan-generator': 5 } },
    });
    expect(eff.attemptCeilings['gan-generator']).toBe(5);
    // The unspecified role keeps its seed default rather than being dropped.
    expect(eff.attemptCeilings['gan-contract-proposer']).toBe(3);
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 5 });
  });

  it('safety.sprintBudget overrides the default 12', () => {
    const eff = resolveEffectiveSafetyConfig({ overlay: { sprintBudget: 20 } });
    expect(eff.sprintBudget).toBe(20);
    // Ceilings untouched by a budget-only override.
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
  });

  it('safety.oscillationDetection: false yields effective false', () => {
    const eff = resolveEffectiveSafetyConfig({ overlay: { oscillationDetection: false } });
    expect(eff.oscillationDetection).toBe(false);
  });

  it('safety.oscillationDetection: true (and absent) yields effective true', () => {
    expect(resolveEffectiveSafetyConfig({ overlay: { oscillationDetection: true } }).oscillationDetection).toBe(true);
    expect(resolveEffectiveSafetyConfig({ overlay: {} }).oscillationDetection).toBe(true);
  });
});

describe('resolveEffectiveSafetyConfig — --max-attempts flag', () => {
  it('uniform ceiling n on EVERY multi-attempt role AND sprintBudget = n × roleCount + 4', () => {
    const n = 2;
    const eff = resolveEffectiveSafetyConfig({ flags: { maxAttempts: n } });
    // Uniform: every seeded multi-attempt role capped at n, not just one.
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 2, 'gan-generator': 2 });
    // roleCount = number of multi-attempt roles = 2 here, so 2 × 2 + 4 = 8.
    const roleCount = Object.keys(DEFAULT_ATTEMPT_CEILINGS).length;
    expect(roleCount).toBe(2);
    expect(MAX_ATTEMPTS_BUDGET_HEADROOM).toBe(4);
    expect(eff.sprintBudget).toBe(n * roleCount + 4);
    expect(eff.sprintBudget).toBe(8);
  });

  it('a different n: --max-attempts=3 ⇒ uniform 3 and budget 3 × 2 + 4 = 10', () => {
    const eff = resolveEffectiveSafetyConfig({ flags: { maxAttempts: 3 } });
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    expect(eff.sprintBudget).toBe(10);
  });

  it('--max-attempts=2 OVERRIDES a conflicting overlay (ceiling AND budget from the flag)', () => {
    const eff = resolveEffectiveSafetyConfig({
      overlay: { attemptCeilings: { 'gan-generator': 5 }, sprintBudget: 50 },
      flags: { maxAttempts: 2 },
    });
    // The overlay set gan-generator: 5, but the flag's uniform 2 wins.
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 2, 'gan-generator': 2 });
    // The overlay set sprintBudget: 50, but the flag-derived 8 wins.
    expect(eff.sprintBudget).toBe(8);
  });

  it('a malformed --max-attempts (zero / non-integer) is ignored, overlay/default applies', () => {
    const zero = resolveEffectiveSafetyConfig({ overlay: { sprintBudget: 20 }, flags: { maxAttempts: 0 } });
    expect(zero.sprintBudget).toBe(20);
    expect(zero.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    const frac = resolveEffectiveSafetyConfig({ flags: { maxAttempts: 2.5 } });
    expect(frac.sprintBudget).toBe(12);
  });
});

describe('resolveEffectiveSafetyConfig — prototype-pollution resistance', () => {
  it('a __proto__-named ceiling key does not pollute, crash, or shadow real roles', () => {
    const before = ({} as Record<string, unknown>)['polluted'];
    const eff = resolveEffectiveSafetyConfig({
      overlay: {
        attemptCeilings: {
          // Deliberate hostile-input fixture: a __proto__-named ceiling key.
          ['__proto__' as string]: 99,
          ['constructor' as string]: 99,
          ['prototype' as string]: 99,
          'gan-generator': 5,
        } as Record<string, number>,
      },
    });
    // No pollution: a plain object's prototype is untouched.
    expect(({} as Record<string, unknown>)['polluted']).toBe(before);
    expect(Object.prototype).not.toHaveProperty('polluted');
    // The forbidden keys are dropped, and the real role still resolves.
    expect(eff.attemptCeilings['gan-generator']).toBe(5);
    expect(eff.attemptCeilings['gan-contract-proposer']).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(eff.attemptCeilings, '__proto__')).toBe(false);
  });
});

describe('resolveEffectiveSafetyConfig — renegotiationCap (effective_safety_config_resolves_renegotiation_cap)', () => {
  it('defaults renegotiationCap to 2 when the overlay is absent', () => {
    // An empty input must yield the seed default — the spec's stated value
    // for the per-sprint renegotiation cap.
    const eff = resolveEffectiveSafetyConfig({});
    expect(eff.renegotiationCap).toBe(2);
    expect(eff.renegotiationCap).toBe(DEFAULT_RENEGOTIATION_CAP);
  });

  it('defaults renegotiationCap to 2 when the overlay omits the field', () => {
    // An overlay setting other safety fields but omitting renegotiationCap
    // must still yield the default — additive change semantics.
    const eff = resolveEffectiveSafetyConfig({
      overlay: { attemptCeilings: { 'gan-generator': 5 }, sprintBudget: 20 },
    });
    expect(eff.renegotiationCap).toBe(DEFAULT_RENEGOTIATION_CAP);
  });

  it('returns the overlay-supplied value when present (overlay beats default)', () => {
    const eff = resolveEffectiveSafetyConfig({ overlay: { renegotiationCap: 5 } });
    expect(eff.renegotiationCap).toBe(5);
  });

  it('a mis-typed overlay renegotiationCap degrades to the default', () => {
    // Schema validation rejects mis-typed values at the validation seam,
    // but the resolver is a pure function; defensive narrowing keeps a
    // hypothetical validation-bypass from producing a bogus effective
    // value (zero, negative, fractional).
    expect(
      resolveEffectiveSafetyConfig({ overlay: { renegotiationCap: 0 } }).renegotiationCap,
    ).toBe(DEFAULT_RENEGOTIATION_CAP);
    expect(
      resolveEffectiveSafetyConfig({ overlay: { renegotiationCap: -3 } }).renegotiationCap,
    ).toBe(DEFAULT_RENEGOTIATION_CAP);
    expect(
      resolveEffectiveSafetyConfig({ overlay: { renegotiationCap: 2.5 } }).renegotiationCap,
    ).toBe(DEFAULT_RENEGOTIATION_CAP);
  });

  it('preserves the pre-existing precedence and field set when renegotiationCap is added', () => {
    // The additive change must not perturb attemptCeilings, sprintBudget,
    // or oscillationDetection. Pinning the full effective config in one
    // assertion catches a regression that quietly drops or renames a
    // pre-existing field.
    const eff = resolveEffectiveSafetyConfig({
      overlay: { attemptCeilings: { 'gan-generator': 4 }, sprintBudget: 9, oscillationDetection: false, renegotiationCap: 3 },
    });
    expect(eff).toEqual({
      attemptCeilings: { 'gan-contract-proposer': 3, 'gan-generator': 4 },
      sprintBudget: 9,
      oscillationDetection: false,
      renegotiationCap: 3,
    });
  });
});

describe('safety constants are unedited (effective_safety_config_a1_constants_unedited)', () => {
  it('DEFAULT_SPRINT_BUDGET is 12 (the seeded sprint-wide budget)', () => {
    // The sprint budget was seeded at 12 (per-role multi-attempt ceiling
    // sum 6 + headroom 6 for the four non-multi-attempt roles). The
    // renegotiation-cap work is additive and must not re-tune this
    // pre-existing constant.
    expect(DEFAULT_SPRINT_BUDGET).toBe(12);
  });

  it('MAX_ATTEMPTS_BUDGET_HEADROOM is 4 (the +4 headroom in the --max-attempts derivation)', () => {
    // The `--max-attempts=n` derivation is `n × roleCount + 4`; the 4 is
    // the headroom for clarifier/planner/reviewer/evaluator, baked into
    // the pre-existing safety layer.
    expect(MAX_ATTEMPTS_BUDGET_HEADROOM).toBe(4);
  });

  it('DEFAULT_ATTEMPT_CEILINGS still seeds proposer=3 and generator=3', () => {
    // The per-role seed ceilings: any change here would shift the
    // sprint-budget derivation and silently re-tune the loop machinery.
    expect(DEFAULT_ATTEMPT_CEILINGS).toEqual({
      'gan-contract-proposer': 3,
      'gan-generator': 3,
    });
  });
});

describe('readSafetyOverlayBlock — merged-overlay extraction', () => {
  it('extracts well-typed safety.* fields from a merged splice-point map', () => {
    const block = readSafetyOverlayBlock({
      safety: {
        attemptCeilings: { 'gan-generator': 5 },
        sprintBudget: 20,
        oscillationDetection: false,
        renegotiationCap: 4,
      },
      runner: { thresholdOverride: 7 },
    });
    expect(block).toEqual({
      attemptCeilings: { 'gan-generator': 5 },
      sprintBudget: 20,
      oscillationDetection: false,
      renegotiationCap: 4,
    });
  });

  it('a merged overlay with no safety block yields an empty block', () => {
    expect(readSafetyOverlayBlock({ runner: { thresholdOverride: 7 } })).toEqual({});
    expect(readSafetyOverlayBlock({})).toEqual({});
    expect(readSafetyOverlayBlock(null)).toEqual({});
  });

  it('round-trips through the resolver: merged overlay → block → effective config', () => {
    const block = readSafetyOverlayBlock({ safety: { attemptCeilings: { 'gan-generator': 5 } } });
    const eff = resolveEffectiveSafetyConfig({ overlay: block });
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 5 });
  });
});

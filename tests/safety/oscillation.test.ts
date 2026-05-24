/**
 * Edit-oscillation detection suite — proves the generator-history detector is
 * a pure decision over the per-attempt fingerprint history, with the two
 * independent triggers, the post-rejection guard, and the single-LoopDetected
 * halt path.
 *
 * Each behaviour is asserted as its own case so a partial
 * implementation cannot pass by satisfying only the others: directRepeat halts
 * on [A, A, A] after the second repeat; the negative that [A, A] does NOT halt;
 * 3cycle halts on [A, B, A] independently of directRepeat; the post-rejection
 * guard (a repeat not following a rejection does not halt, the same repeat with
 * the flag set does); the editOscillation evidence shape + its validator
 * (well-formed true, malformed false) including seq[0] == seq[2] for the 3cycle
 * worked example; reuse of the single LoopDetected error code +
 * buildLoopDetectedBody; the gan-generator role id; and the prototype-pollution
 * guard on the seen-fingerprint history structure.
 */

import { describe, expect, it } from 'vitest';

import {
  OSCILLATION_ROLE,
  detectEditOscillation,
  isEditOscillationEvidence,
  renderEditOscillationMessage,
  createEditOscillationError,
  type AttemptFingerprint,
  type EditOscillationEvidence,
  type FingerprintHistory,
} from '../../src/safety/oscillation.js';
import { fingerprintEditSet } from '../../src/safety/fingerprint.js';
import { buildLoopDetectedBody } from '../../src/trace/integration.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';

const RUN_ID = '20260523T171711-0388';

// Three distinct, genuine fingerprints produced by the fingerprint layer, so
// the detector is exercised against the *exact* digest shape it will see at
// runtime (64-char lowercase hex) rather than hand-typed stand-ins.
const FP_A = fingerprintEditSet([{ path: 'src/a.ts', content: 'export const a = 1;' }]);
const FP_B = fingerprintEditSet([{ path: 'src/b.ts', content: 'export const b = 2;' }]);
const FP_C = fingerprintEditSet([{ path: 'src/c.ts', content: 'export const c = 3;' }]);

// Build a history from a list of [fingerprint, followedRejection] pairs so a
// test reads as a sequence of attempts without restating the entry shape.
function history(
  ...entries: ReadonlyArray<readonly [string, boolean]>
): FingerprintHistory {
  return entries.map(([fingerprint, followedRejection]) => ({ fingerprint, followedRejection }));
}

describe('directRepeat_halts_on_triple_same_edit_after_second_repeat', () => {
  it('halts on [A, A, A] post-rejection with detectedPattern directRepeat', () => {
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_A, true], [FP_A, true]),
    );

    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('editOscillation');
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');
  });

  it('halts at the third attempt (after the second repeat), not the first repeat', () => {
    // The evidence window runs through the third recurrence, so its last
    // element is the third A and the sequence has length 3 — proving the halt
    // fired at the third attempt, not earlier.
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_A, true], [FP_A, true]),
    );
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.fingerprintSequence).toEqual([FP_A, FP_A, FP_A]);
    expect(decision.fields?.attempts).toBe(3);
  });
});

describe('single_isolated_repeat_does_not_halt', () => {
  it('a 2-element [A, A] post-rejection history does NOT halt', () => {
    // One isolated repeat could be an instructed revert; the halt must wait for
    // the second repeat (the third occurrence), so two A's never halt.
    const decision = detectEditOscillation(history([FP_A, true], [FP_A, true]));
    expect(decision.halt).toBe(false);
    expect(decision.fields).toBeUndefined();
  });

  it('a longer history whose only repeat is one adjacent pair does NOT halt', () => {
    // [A, A, B, C]: A repeats once (two occurrences) and nothing recurs a third
    // time, so neither directRepeat nor 3cycle fires.
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_A, true], [FP_B, true], [FP_C, true]),
    );
    expect(decision.halt).toBe(false);
  });
});

describe('threecycle_halts_on_ABA_post_rejection', () => {
  it('halts on [A, B, A] with detectedPattern 3cycle, seq[0] == seq[2], length 3', () => {
    const decision = detectEditOscillation(history([FP_A, true], [FP_B, true], [FP_A, true]));

    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('editOscillation');
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('3cycle');
    expect(evidence.fingerprintSequence).toHaveLength(3);
    // The worked-example invariant: attempt N equals attempt N-2.
    expect(evidence.fingerprintSequence[0]).toBe(evidence.fingerprintSequence[2]);
    expect(evidence.fingerprintSequence).toEqual([FP_A, FP_B, FP_A]);
  });

  it('fires independently of directRepeat: an A-B-A with no adjacent repeat still halts', () => {
    // No two adjacent attempts share a fingerprint (A!=B, B!=A), so directRepeat
    // (which needs a third occurrence) cannot fire — only the N vs N-2 trigger.
    const decision = detectEditOscillation(history([FP_A, true], [FP_B, true], [FP_A, true]));
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('3cycle');
  });

  it('does not 3cycle when the intervening attempt equals the repeat (A, A, A is directRepeat)', () => {
    // A->A->A is a direct repeat, not an A->B->A alternation; the 3cycle guard
    // requires the middle attempt to differ, so this classifies as directRepeat.
    const decision = detectEditOscillation(history([FP_A, true], [FP_A, true], [FP_A, true]));
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');
  });
});

describe('post_rejection_guard_suppresses_repeats_not_following_rejection', () => {
  it('a repeat NOT following a rejection does not halt (instructed revert)', () => {
    // [A, A, A] but the repeating attempts are flagged as voluntary reverts
    // (followedRejection false): an instructed revert is not oscillation.
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_A, false], [FP_A, false]),
    );
    expect(decision.halt).toBe(false);
  });

  it('the otherwise-identical history with the post-rejection flag set DOES halt', () => {
    // Same fingerprints, same length — only the flag on the third (repeating)
    // attempt differs, proving the guard is what gates the halt.
    const suppressed = detectEditOscillation(
      history([FP_A, true], [FP_A, true], [FP_A, false]),
    );
    expect(suppressed.halt).toBe(false);

    const halts = detectEditOscillation(
      history([FP_A, true], [FP_A, true], [FP_A, true]),
    );
    expect(halts.halt).toBe(true);
    const evidence = halts.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');
  });

  it('the guard gates 3cycle too: an A-B-A whose final A is not post-rejection does not halt', () => {
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_B, true], [FP_A, false]),
    );
    expect(decision.halt).toBe(false);
  });

  it('a non-post-rejection repeat still counts toward a later post-rejection repeat', () => {
    // The middle A is a voluntary revert (no halt on it), but it is a real
    // occurrence: the third A, which IS post-rejection, sees three occurrences
    // and halts. The guard suppresses the halt, never the bookkeeping.
    const decision = detectEditOscillation(
      history([FP_A, true], [FP_A, false], [FP_A, true]),
    );
    expect(decision.halt).toBe(true);
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');
  });
});

describe('editOscillation_evidence_validates_against_fingerprintSequence_detectedPattern_shape', () => {
  it('accepts the produced evidence and the worked 3cycle example', () => {
    const decision = detectEditOscillation(history([FP_A, true], [FP_B, true], [FP_A, true]));
    expect(isEditOscillationEvidence(decision.fields?.evidence)).toBe(true);

    // The worked payload: detectedPattern "3cycle", a 3-element
    // sequence with seq[0] == seq[2].
    const worked: EditOscillationEvidence = {
      detectedPattern: '3cycle',
      fingerprintSequence: [
        'a3f2c8b1d9e7f4a6c2b8d1e5f9a3c7b4e2d8f1a5c9b3e7d2f8a4c1b6e9d3f7a2',
        'b8e1c4d7f2a9e3c6b1d4f7a2e9c5b8d1f4a7c2e6b9d3f1a8c5e2b6d9f3a7c1e4',
        'a3f2c8b1d9e7f4a6c2b8d1e5f9a3c7b4e2d8f1a5c9b3e7d2f8a4c1b6e9d3f7a2',
      ],
    };
    expect(isEditOscillationEvidence(worked)).toBe(true);
    expect(worked.fingerprintSequence[0]).toBe(worked.fingerprintSequence[2]);

    expect(
      isEditOscillationEvidence({ detectedPattern: 'directRepeat', fingerprintSequence: [FP_A] }),
    ).toBe(true);
  });

  it('rejects mis-shaped values', () => {
    // Wrong detectedPattern literal.
    expect(
      isEditOscillationEvidence({ detectedPattern: 'twoCycle', fingerprintSequence: [FP_A] }),
    ).toBe(false);
    // A non-hex sequence element.
    expect(
      isEditOscillationEvidence({ detectedPattern: '3cycle', fingerprintSequence: ['not-hex'] }),
    ).toBe(false);
    // A wrong-length (truncated) hex element.
    expect(
      isEditOscillationEvidence({ detectedPattern: 'directRepeat', fingerprintSequence: ['abc123'] }),
    ).toBe(false);
    // Uppercase hex is not lowercase-canonical.
    expect(
      isEditOscillationEvidence({
        detectedPattern: 'directRepeat',
        fingerprintSequence: [FP_A.toUpperCase()],
      }),
    ).toBe(false);
    // Missing fingerprintSequence.
    expect(isEditOscillationEvidence({ detectedPattern: '3cycle' })).toBe(false);
    // Missing detectedPattern.
    expect(isEditOscillationEvidence({ fingerprintSequence: [FP_A] })).toBe(false);
    // fingerprintSequence not an array.
    expect(
      isEditOscillationEvidence({ detectedPattern: '3cycle', fingerprintSequence: FP_A }),
    ).toBe(false);
    // Not an object / array / null.
    expect(isEditOscillationEvidence(null)).toBe(false);
    expect(isEditOscillationEvidence([])).toBe(false);
    expect(isEditOscillationEvidence('nope')).toBe(false);
  });
});

describe('reuses_single_LoopDetected_error_and_buildLoopDetectedBody_no_parallel_path', () => {
  const decision = detectEditOscillation(history([FP_A, true], [FP_B, true], [FP_A, true]));
  const fields = decision.fields!;

  it('constructs a LoopDetected error with the editOscillation discriminator', () => {
    const error = createEditOscillationError(
      fields,
      `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`,
    );

    // Same error code as the per-role and budget halts — one LoopDetected code.
    expect(error.code).toBe('LoopDetected');
    expect(error.reason).toBe('editOscillation');
    expect(error.role).toBe('gan-generator');
    expect(error.attempts).toBe(3);

    const json = error.toJSON();
    expect(json.code).toBe('LoopDetected');
    for (const field of ['reason', 'role', 'attempts', 'ceiling', 'evidence']) {
      expect(Object.prototype.hasOwnProperty.call(json, field)).toBe(true);
    }
    // The evidence carried on the error validates against its declared shape.
    expect(isEditOscillationEvidence(json.evidence)).toBe(true);
  });

  it('feeds buildLoopDetectedBody to produce a schema-valid safetyHalt body', () => {
    const body = buildLoopDetectedBody({
      reason: fields.reason,
      role: fields.role,
      attempts: fields.attempts,
      ceiling: fields.ceiling,
      evidence: fields.evidence,
    });

    expect(body.safetyClass).toBe('loopDetected');
    expect(body.role).toBe('gan-generator');
    expect(body.payload.reason).toBe('editOscillation');

    // Wrapped in an envelope it validates against the run-trace schema (the
    // trace owns the safetyHalt class; the safety layer supplies the
    // loopDetected discriminator value and the editOscillation evidence shape).
    const validate = getRunTraceValidator();
    const event = {
      sequenceNumber: 7,
      eventType: 'safetyHalt',
      timestamp: '2026-05-23T17:17:11.000Z',
      runId: RUN_ID,
      ...body,
    };
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('detector_role_id_is_gan_generator_kebab_case', () => {
  it('the role constant is exactly the kebab-case "gan-generator"', () => {
    expect(OSCILLATION_ROLE).toBe('gan-generator');
  });

  it('a halt stamps role "gan-generator", not the "sprint" sentinel', () => {
    const decision = detectEditOscillation(history([FP_A, true], [FP_A, true], [FP_A, true]));
    expect(decision.fields?.role).toBe('gan-generator');
    expect(decision.fields?.role).not.toBe('sprint');
  });
});

describe('oscillation_history_keyed_structure_resists_prototype_pollution', () => {
  it('a __proto__-named fingerprint neither pollutes Object.prototype nor crashes', () => {
    // Three attempts whose "fingerprint" is literally the pollution vector, all
    // post-rejection. The detector must treat it as opaque data: it should still
    // detect the directRepeat (it is a genuine third occurrence by value) WITHOUT
    // setting anything on Object.prototype or throwing.
    const decision = detectEditOscillation(
      history(['__proto__', true], ['__proto__', true], ['__proto__', true]),
    );

    expect(decision.halt).toBe(true);
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');

    // Nothing leaked onto the prototype.
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not collapse two genuinely-different pollution-named histories into a false repeat', () => {
    // "constructor" and "prototype" are distinct values; a single occurrence of
    // each (no third recurrence) must NOT be mistaken for a repeat just because
    // they are pollution-named keys.
    const decision = detectEditOscillation(
      history(['constructor', true], ['prototype', true], [FP_A, true]),
    );
    expect(decision.halt).toBe(false);

    // And nothing leaked.
    expect((Object.prototype as Record<string, unknown>).attemptCount).toBeUndefined();
  });

  it('a mix of pollution-named and real fingerprints does not crash and tracks counts correctly', () => {
    // A real fingerprint precedes three consecutive pollution-named entries: the
    // pollution-named value reaches its third occurrence (directRepeat) at index
    // 3 via key-safe bookkeeping. No A→B→A window on it (its neighbours are also
    // pollution-named, so 3cycle's "middle differs" guard never matches), so the
    // detector must fire directRepeat on the third occurrence, undisturbed by the
    // prototype-pollution vector.
    const decision = detectEditOscillation(
      history([FP_A, true], ['__proto__', true], ['__proto__', true], ['__proto__', true]),
    );
    expect(decision.halt).toBe(true);
    const evidence = decision.fields?.evidence as unknown as EditOscillationEvidence;
    expect(evidence.detectedPattern).toBe('directRepeat');

    // Nothing leaked onto the prototype despite the pollution-named recurrence.
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);
  });
});

describe('edit_oscillation_halt_message_follows_user_facing_error_discipline', () => {
  const traceDir = `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`;

  it('points at the trace directory and mentions --recover', () => {
    const message = renderEditOscillationMessage({ attempts: 3 }, 'directRepeat', traceDir);
    expect(message).toContain(traceDir);
    expect(message).toContain('--recover');
  });

  it('refers to the framework / ClaudeAgents', () => {
    const message = renderEditOscillationMessage({ attempts: 3 }, '3cycle', traceDir);
    expect(/\b(the framework|ClaudeAgents)\b/.test(message)).toBe(true);
  });

  it('contains no forbidden ecosystem or maintainer-script tokens', () => {
    const message = renderEditOscillationMessage({ attempts: 3 }, 'directRepeat', traceDir);
    const forbidden = [
      'npm',
      'node',
      'vitest',
      'pnpm',
      'yarn',
      'package.json',
      'tsconfig',
      'lint-no-stack-leak',
      'lint-error-text',
    ];
    const lower = message.toLowerCase();
    for (const token of forbidden) {
      expect(lower.includes(token.toLowerCase()), `message must not contain '${token}'`).toBe(
        false,
      );
    }
  });
});

describe('detector_is_pure_over_an_empty_or_short_history', () => {
  it('an empty history does not halt', () => {
    expect(detectEditOscillation([]).halt).toBe(false);
  });

  it('a single attempt does not halt', () => {
    const single: AttemptFingerprint[] = [{ fingerprint: FP_A, followedRejection: true }];
    expect(detectEditOscillation(single).halt).toBe(false);
  });
});

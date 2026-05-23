/**
 * loopDetected safety-halt body-builder suite — proves buildLoopDetectedBody
 * mirrors the existing trace body builders (pure mapping, schema-valid envelope)
 * and carries the A1 loop-detection halt detail.
 *
 * The builder lifts the triggering `role` to the event's top-level field and
 * inlines the loop-specific reason/attempts/ceiling/evidence into the small
 * `payload`, with `safetyClass = "loopDetected"`. Wrapped in an envelope it
 * validates against run-trace-v1 (T1 owns the safetyHalt class; A1 supplies the
 * loopDetected discriminator value and payload). The new LoopDetected exit code
 * is asserted distinct from every validation-class code.
 */

import { describe, expect, it } from 'vitest';

import { buildLoopDetectedBody } from '../../src/trace/integration.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';
import { buildRoleCeilingEvidence } from '../../src/safety/loop-detection.js';

const RUN_ID = '20260521T194720-6752';

function envelope(eventType: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    sequenceNumber: 11,
    eventType,
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
    ...body,
  };
}

describe('safety_halt_loop_detected_body_builder_mirrors_existing_builders', () => {
  const evidence = buildRoleCeilingEvidence([
    { outputArtifactPath: 'attempts/gan-contract-proposer-1.json', summary: 'rejected: shape' },
    { outputArtifactPath: 'attempts/gan-contract-proposer-2.json', summary: 'rejected: shape' },
    { outputArtifactPath: 'attempts/gan-contract-proposer-3.json', summary: 'rejected: shape' },
  ]);

  it('produces a loopDetected body with the triggering role and halt payload', () => {
    const body = buildLoopDetectedBody({
      reason: 'roleCeilingExceeded',
      role: 'gan-contract-proposer',
      attempts: 3,
      ceiling: 3,
      evidence,
    });

    expect(body.safetyClass).toBe('loopDetected');
    expect(body.role).toBe('gan-contract-proposer');
    expect(body.payload.reason).toBe('roleCeilingExceeded');
    expect(body.payload.attempts).toBe(3);
    expect(body.payload.ceiling).toBe(3);
    expect(body.payload.evidence).toEqual(evidence);

    // The body is exactly the event minus its envelope — no envelope fields leak.
    expect(Object.keys(body).sort()).toEqual(['payload', 'role', 'safetyClass']);
  });

  it('validates against the run-trace schema when wrapped in an envelope', () => {
    const validate = getRunTraceValidator();
    const body = buildLoopDetectedBody({
      reason: 'roleCeilingExceeded',
      role: 'gan-generator',
      attempts: 3,
      ceiling: 3,
      evidence,
    });
    const event = envelope('safetyHalt', { ...body });
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

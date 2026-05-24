/**
 * Per-role attempt-ceiling suite — proves the framework-owned halt primitive
 * is a pure decision over reconstructed attempt counts, with the halt contract
 * (LoopDetected error fields, evidence shape, seed-default table) the framework
 * mandates.
 *
 * Ceiling check: a proposer rejected three times in a row (ceiling 3) halts with
 * reason=roleCeilingExceeded, role=gan-contract-proposer; a role at or below its
 * ceiling does not. The check consumes RoleAttemptState / attemptStateByRole as
 * reconstructed from the trace (reconstructRecoveryState) — never a bespoke
 * counter — so the same accounting the recovery path uses drives the halt.
 *
 * Default table: exactly the two multi-attempt roles (gan-contract-proposer,
 * gan-generator) at 3; single-attempt (clarifier/planner) and once-per-output
 * (reviewer/evaluator) roles are absent.
 *
 * LoopDetected error: PascalCase code with the five halt-contract fields; the
 * roleCeilingExceeded evidence validates against its shape and a mis-shaped value
 * is rejected.
 *
 * Prototype-pollution guard: a __proto__-named role neither pollutes
 * Object.prototype nor crashes the check, mirroring the reconcile guard.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTEMPT_CEILINGS,
  checkRoleCeiling,
  buildRoleCeilingEvidence,
  isRoleCeilingEvidence,
  renderRoleCeilingMessage,
  createLoopDetectedError,
} from '../../src/safety/loop-detection.js';
import { reconstructRecoveryState } from '../../src/trace/reconcile.js';
import { TraceEmitter } from '../../src/trace/emitter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUN_ID = '20260521T194720-6752';

// Build a trace on disk with `count` completed agentAttempt events for `role`,
// then reconstruct the attempt state — exercising the real seam the ceiling
// check is meant to compose with, not a hand-built counter.
function attemptStateFromTrace(role: string, count: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-safety-'));
  try {
    let t = Date.parse('2026-05-21T19:47:20.000Z');
    const emitter = new TraceEmitter(
      { traceRoot: path.join(dir, 'trace'), runId: RUN_ID },
      () => (t += 1),
    );
    for (let i = 1; i <= count; i += 1) {
      emitter.emitAgentAttempt({
        role,
        attemptNumber: i,
        inputs: { attempt: i },
        outputArtifactPath: `attempts/${role}-${i}.json`,
        disposition: 'objected',
      });
    }
    return reconstructRecoveryState(path.join(dir, 'trace')).attemptStateByRole[role];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('default_ceilings_are_only_multi_attempt_roles_and_match_spec', () => {
  it('contains exactly gan-contract-proposer:3 and gan-generator:3', () => {
    expect(DEFAULT_ATTEMPT_CEILINGS['gan-contract-proposer']).toBe(3);
    expect(DEFAULT_ATTEMPT_CEILINGS['gan-generator']).toBe(3);
    expect(Object.keys(DEFAULT_ATTEMPT_CEILINGS).sort()).toEqual([
      'gan-contract-proposer',
      'gan-generator',
    ]);
  });

  it('does not list single-attempt or once-per-output roles', () => {
    for (const role of ['gan-clarifier', 'gan-planner', 'gan-contract-reviewer', 'gan-evaluator']) {
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_ATTEMPT_CEILINGS, role)).toBe(false);
    }
  });
});

describe('role_ceiling_check_halts_proposer_after_three_rejections', () => {
  it('halts when the proposer has been rejected three times (ceiling 3)', () => {
    const attemptState = attemptStateFromTrace('gan-contract-proposer', 3);
    const evidence = buildRoleCeilingEvidence([
      { outputArtifactPath: 'attempts/gan-contract-proposer-1.json', summary: 'rejected: shape' },
      { outputArtifactPath: 'attempts/gan-contract-proposer-2.json', summary: 'rejected: shape' },
      { outputArtifactPath: 'attempts/gan-contract-proposer-3.json', summary: 'rejected: shape' },
    ]);

    const decision = checkRoleCeiling({ role: 'gan-contract-proposer', attemptState, evidence });

    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('roleCeilingExceeded');
    expect(decision.fields?.role).toBe('gan-contract-proposer');
    expect(decision.fields?.attempts).toBe(3);
    expect(decision.fields?.ceiling).toBe(3);
    expect(decision.fields?.evidence).toHaveLength(3);
  });

  it('does not halt when the role stays below its ceiling', () => {
    const attemptState = attemptStateFromTrace('gan-contract-proposer', 2);
    const decision = checkRoleCeiling({ role: 'gan-contract-proposer', attemptState });
    expect(decision.halt).toBe(false);
    expect(decision.fields).toBeUndefined();
  });

  it('does not halt a role with no ceiling in the table (e.g. a single-attempt role)', () => {
    const attemptState = attemptStateFromTrace('gan-planner', 5);
    const decision = checkRoleCeiling({ role: 'gan-planner', attemptState });
    expect(decision.halt).toBe(false);
  });

  it('does not halt a role with no attempt state yet', () => {
    const decision = checkRoleCeiling({ role: 'gan-generator', attemptState: undefined });
    expect(decision.halt).toBe(false);
  });

  it('honours a caller-supplied ceiling table (an overlay-style override)', () => {
    const attemptState = attemptStateFromTrace('gan-generator', 3);
    const raised = checkRoleCeiling({
      role: 'gan-generator',
      attemptState,
      ceilings: { 'gan-generator': 5 },
    });
    expect(raised.halt).toBe(false);
  });
});

describe('loop_detected_error_uses_pascalcase_code_and_required_fields', () => {
  it('produces a LoopDetected error carrying all five halt-contract fields', () => {
    const evidence = buildRoleCeilingEvidence([
      { outputArtifactPath: 'attempts/gan-contract-proposer-1.json', summary: 'rejected' },
      { outputArtifactPath: 'attempts/gan-contract-proposer-2.json', summary: 'rejected' },
      { outputArtifactPath: 'attempts/gan-contract-proposer-3.json', summary: 'rejected' },
    ]);
    const error = createLoopDetectedError(
      {
        reason: 'roleCeilingExceeded',
        role: 'gan-contract-proposer',
        attempts: 3,
        ceiling: 3,
        evidence,
      },
      `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`,
    );

    expect(error.code).toBe('LoopDetected');
    expect(error.reason).toBe('roleCeilingExceeded');
    expect(error.role).toBe('gan-contract-proposer');
    expect(error.attempts).toBe(3);
    expect(error.ceiling).toBe(3);
    expect(Array.isArray(error.evidence)).toBe(true);

    // The five fields survive the JSON projection that crosses the MCP boundary.
    const json = error.toJSON();
    expect(json.code).toBe('LoopDetected');
    for (const field of ['reason', 'role', 'attempts', 'ceiling', 'evidence']) {
      expect(Object.prototype.hasOwnProperty.call(json, field)).toBe(true);
    }
  });
});

describe('role_ceiling_evidence_matches_discriminator_shape', () => {
  it('accepts a well-formed roleCeilingExceeded evidence array', () => {
    const evidence = buildRoleCeilingEvidence([
      { outputArtifactPath: 'attempts/a-1.json', summary: 'first' },
      { outputArtifactPath: 'attempts/a-2.json', summary: 'second' },
    ]);
    expect(isRoleCeilingEvidence(evidence)).toBe(true);
    expect(evidence[0]).toEqual({
      attemptNumber: 1,
      outputArtifactPath: 'attempts/a-1.json',
      summary: 'first',
    });
    expect(evidence[1]?.attemptNumber).toBe(2);
  });

  it('rejects a mis-shaped value (entry missing outputArtifactPath)', () => {
    const bad = [{ attemptNumber: 1, summary: 'no path here' }];
    expect(isRoleCeilingEvidence(bad)).toBe(false);
  });

  it('rejects a non-array value', () => {
    expect(isRoleCeilingEvidence({ attemptNumber: 1 })).toBe(false);
    expect(isRoleCeilingEvidence(null)).toBe(false);
  });
});

describe('role_keyed_accumulation_guards_against_prototype_pollution', () => {
  it('a __proto__-named role neither pollutes Object.prototype nor crashes', () => {
    // A synthetic attempt history whose role is the pollution vector. The check
    // must treat it as "no real configured role" rather than indexing the table
    // through an inherited member.
    const decision = checkRoleCeiling({
      role: '__proto__',
      attemptState: { attemptCount: 99, highestAttemptNumber: 99 },
    });
    expect(decision.halt).toBe(false);

    // Nothing leaked onto the prototype.
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).halt).toBeUndefined();
  });

  it('a constructor-named role is also refused without crashing', () => {
    const decision = checkRoleCeiling({
      role: 'constructor',
      attemptState: { attemptCount: 99, highestAttemptNumber: 99 },
    });
    expect(decision.halt).toBe(false);
  });
});

describe('halt_message_follows_user_facing_error_discipline', () => {
  const traceDir = `<store-root>/<repo-key>/runs/${RUN_ID}/trace/`;
  const message = renderRoleCeilingMessage(
    { role: 'gan-generator', attempts: 3, ceiling: 3 },
    traceDir,
  );

  it('points at the trace directory and mentions --recover', () => {
    expect(message).toContain(traceDir);
    expect(message).toContain('--recover');
  });

  it('refers to the framework / ClaudeAgents', () => {
    expect(/\b(the framework|ClaudeAgents)\b/.test(message)).toBe(true);
  });

  it('contains no forbidden ecosystem or maintainer-script tokens', () => {
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

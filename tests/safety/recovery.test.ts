/**
 * Recovery-integration suite — proves the pure recovery pieces
 * that compose on top of the shipped `reconstructRecoveryState` +
 * `checkRoleCeiling`, with no `--recover` orchestrator runtime. Each behaviour
 * is a separately-asserted case so a partial implementation cannot pass by
 * satisfying only the others:
 *
 *   - validateResetAttemptsUsage: --reset-attempts standalone → MalformedInput
 *     structured error; reset+recover, recover-only, and neither → no error;
 *   - the rejection message follows the user-facing error-text discipline;
 *   - buildLoopHaltTerminalRecord sets terminalReason to the literal
 *     "failed-loop-detected" and marks the run terminal;
 *   - effectiveStartingCounters with reset=false PRESERVES an at-ceiling
 *     reconstructed count so checkRoleCeiling halts on the next attempt;
 *   - the SAME reconstructed state with reset=true yields zero effective counts
 *     so checkRoleCeiling does NOT halt (the reset flag is the sole lever);
 *   - the effective counters are derived from a reconstructed RecoveryState
 *     ALONE (round-trip through reconstructRecoveryState, no counter file);
 *   - the counter mapping resists prototype pollution under both flag values.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FAILED_LOOP_DETECTED_TERMINAL_REASON,
  validateResetAttemptsUsage,
  buildLoopHaltTerminalRecord,
  effectiveStartingCounters,
} from '../../src/safety/recovery.js';
import { checkRoleCeiling, DEFAULT_ATTEMPT_CEILINGS } from '../../src/safety/loop-detection.js';
import {
  reconstructRecoveryState,
  type RecoveryState,
  type RoleAttemptState,
} from '../../src/trace/reconcile.js';
import { TraceEmitter } from '../../src/trace/emitter.js';
import {
  seedProgress,
  type RunContextForSeed,
} from '../../src/config-server/storage/run-progress.js';
import { writeProgressFields } from '../../src/agents/independent-review/progress.js';
import { validateProgress } from '../../src/config-server/validation/schema-check.js';
import { readFileSync } from 'node:fs';

const tmpDirs: string[] = [];
const RUN_ID = '20260523T171711-0388';

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTraceRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-recov-int-'));
  tmpDirs.push(dir);
  return path.join(dir, 'trace');
}

function fixedClock(): () => number {
  let t = Date.parse('2026-05-23T17:17:11.000Z');
  return () => {
    t += 1;
    return t;
  };
}

// Build a RecoveryState directly (no I/O) for the pure-mapping cases. The fold
// only reads attemptStateByRole; nextSequence is irrelevant here.
function recoveryState(byRole: Record<string, RoleAttemptState>): RecoveryState {
  const attemptStateByRole: Record<string, RoleAttemptState> = Object.create(null);
  for (const role of Object.keys(byRole)) {
    attemptStateByRole[role] = byRole[role]!;
  }
  return { nextSequence: 0, attemptStateByRole };
}

describe('validateResetAttemptsUsage — recover-only modifier', () => {
  it('--reset-attempts standalone (no --recover) is rejected with a MalformedInput structured error', () => {
    const result = validateResetAttemptsUsage({ recover: false, resetAttempts: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    // The error code resolves through the bad-args/usage class in the exit-code
    // table (MalformedInput → EXIT_BAD_ARGS), and is a constructed
    // ConfigServerError, not a bare thrown Error.
    expect(result.error?.code).toBe('MalformedInput');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.message.length).toBeGreaterThan(0);
  });

  it('--reset-attempts WITH --recover produces no error', () => {
    const result = validateResetAttemptsUsage({ recover: true, resetAttempts: true });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('--recover alone produces no error', () => {
    const result = validateResetAttemptsUsage({ recover: true, resetAttempts: false });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('neither flag produces no error', () => {
    const result = validateResetAttemptsUsage({ recover: false, resetAttempts: false });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('reset_attempts_rejection_message_follows_user_facing_discipline', () => {
  it('the standalone-rejection message names no runtime/ecosystem tooling and refers to the framework', () => {
    const result = validateResetAttemptsUsage({ recover: false, resetAttempts: true });
    const msg = result.error?.message ?? '';
    // Same forbidden ecosystem vocabulary lint-no-stack-leak/lint-error-text
    // police on user-facing emit sites.
    const forbidden = [
      'package.json',
      'package-lock.json',
      'node_modules',
      'npm',
      'pnpm',
      'yarn',
      '.nvmrc',
      'tsconfig.json',
    ];
    for (const token of forbidden) {
      expect(msg).not.toContain(token);
    }
    // Names no maintainer-only script (e.g. a `lint-*`/`vitest` invocation).
    expect(msg.toLowerCase()).not.toContain('vitest');
    expect(msg).not.toContain('node ');
    // References the framework and tells the user the correct usage.
    expect(msg).toContain('ClaudeAgents');
    expect(msg).toContain('--recover');
    expect(msg).toContain('--reset-attempts');
  });
});

describe('loop_halt_writes_recoverable_terminal_reason', () => {
  it('builds a terminal record with terminalReason exactly "failed-loop-detected"', () => {
    const record = buildLoopHaltTerminalRecord();
    expect(record.terminalReason).toBe('failed-loop-detected');
    expect(record.terminalReason).toBe(FAILED_LOOP_DETECTED_TERMINAL_REASON);
    // Marks the run terminal in the recoverable sense.
    expect(record.terminal).toBe(true);
  });

  it('the exported terminal-reason literal is the kebab-case recoverable-terminal convention', () => {
    expect(FAILED_LOOP_DETECTED_TERMINAL_REASON).toBe('failed-loop-detected');
  });

  it('emits terminalAt as an ISO-8601 UTC string matching the schema isoDateTime pattern', () => {
    // Default clock: pin only the shape (the value is non-deterministic).
    const record = buildLoopHaltTerminalRecord();
    expect(typeof record.terminalAt).toBe('string');
    expect(record.terminalAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
  });

  it('stamps terminalAt with the injected clock when nowFn is provided (determinism seam)', () => {
    const fixed = new Date('2026-06-01T03:08:30.500Z');
    const record = buildLoopHaltTerminalRecord({ nowFn: () => fixed });
    expect(record.terminalAt).toBe('2026-06-01T03:08:30.500Z');
  });
});

// ---------------------------------------------------------------------------
// progress-v1 conformance for the loop-halt terminal record (cluster C-2 /
// I-001). seedProgress births the full required-set; the builder's record
// merges in; the on-disk document validates clean. This is the live-writer
// arm of the resolution: the schema's cross-field invariant (terminal:true
// ⇒ non-null terminalReason AND non-null terminalAt) is satisfied at the
// writer site, not patched at a downstream gate.
// ---------------------------------------------------------------------------

function liveRunContext(): RunContextForSeed {
  return {
    runId: '20260601T030830-1a2b',
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'feature/sample',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath: '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
    },
    overlaysAtSnapshot: {
      user: { loaded: false, path: null, hash: null },
      project: { loaded: false, path: null, hash: null },
    },
  };
}

describe('buildLoopHaltTerminalRecord — progress-v1 conformance', () => {
  it('seedProgress + builder + writeProgressFields persists a record that validates against progressV1', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'recov-loop-halt-'));
    tmpDirs.push(root);
    const progressFilePath = path.join(root, 'progress.json');
    seedProgress(progressFilePath, liveRunContext());

    const record = buildLoopHaltTerminalRecord();
    writeProgressFields(progressFilePath, { ...record });

    const onDisk = JSON.parse(readFileSync(progressFilePath, 'utf8'));
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});

describe('recovery_without_reset_preserves_counters_and_halts_on_next_attempt', () => {
  it('an at-ceiling gan-generator (attemptCount 3, ceiling 3) preserved under reset=false halts immediately', () => {
    // A reconstructed state already at the role's ceiling.
    const state = recoveryState({
      'gan-generator': { attemptCount: 3, highestAttemptNumber: 3 },
    });
    const ceiling = DEFAULT_ATTEMPT_CEILINGS['gan-generator'];
    expect(ceiling).toBe(3);

    const effective = effectiveStartingCounters({ recoveryState: state, resetAttempts: false });
    // The reconstructed count is preserved verbatim — not silently reset.
    expect(effective['gan-generator']).toBe(3);

    // Feeding the preserved count into the shipped check halts on the next
    // attempt-start, with the role-ceiling reason and the same role.
    const decision = checkRoleCeiling({
      role: 'gan-generator',
      attemptState: { attemptCount: effective['gan-generator']!, highestAttemptNumber: 3 },
    });
    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('roleCeilingExceeded');
    expect(decision.fields?.role).toBe('gan-generator');
  });
});

describe('recovery_with_reset_yields_zero_effective_starting_counters', () => {
  it('the SAME at-ceiling state under reset=true yields zero effective counts and does NOT halt', () => {
    const state = recoveryState({
      'gan-generator': { attemptCount: 3, highestAttemptNumber: 3 },
    });

    const effective = effectiveStartingCounters({ recoveryState: state, resetAttempts: true });
    expect(effective['gan-generator']).toBe(0);

    const decision = checkRoleCeiling({
      role: 'gan-generator',
      attemptState: { attemptCount: effective['gan-generator']!, highestAttemptNumber: 0 },
    });
    expect(decision.halt).toBe(false);
  });

  it('the reset flag is the SOLE lever: identical reconstructed state, opposite halt outcomes', () => {
    const state = recoveryState({
      'gan-generator': { attemptCount: 3, highestAttemptNumber: 3 },
    });

    const preserved = effectiveStartingCounters({ recoveryState: state, resetAttempts: false });
    const reset = effectiveStartingCounters({ recoveryState: state, resetAttempts: true });

    const haltsPreserved = checkRoleCeiling({
      role: 'gan-generator',
      attemptState: { attemptCount: preserved['gan-generator']!, highestAttemptNumber: 3 },
    }).halt;
    const haltsReset = checkRoleCeiling({
      role: 'gan-generator',
      attemptState: { attemptCount: reset['gan-generator']!, highestAttemptNumber: 0 },
    }).halt;

    expect(haltsPreserved).toBe(true);
    expect(haltsReset).toBe(false);
  });
});

describe('counters_reconstructed_from_trace_events_no_separate_counter_file', () => {
  it('effective starting counters are derived from a reconstructed RecoveryState alone (round-trip)', () => {
    const root = makeTraceRoot();
    // Drive three gan-generator attempts purely through the trace emitter — no
    // counter file is written anywhere; the only source of truth is the events.
    const emitter = new TraceEmitter({ traceRoot: root, runId: RUN_ID }, fixedClock());
    emitter.emitOrchestratorMilestone({ milestone: 'sprintStart' });
    for (let n = 1; n <= 3; n += 1) {
      emitter.emitAgentAttempt({
        role: 'gan-generator',
        attemptNumber: n,
        inputs: { n },
        outputArtifactPath: `attempts/gan-generator-${n}.json`,
        disposition: n === 3 ? 'completed' : 'failed',
      });
    }

    // Reconstruct from the trace alone, then map — no separate tally read.
    const state = reconstructRecoveryState(root);
    expect(state.attemptStateByRole['gan-generator']).toEqual({
      attemptCount: 3,
      highestAttemptNumber: 3,
    });

    const effective = effectiveStartingCounters({ recoveryState: state, resetAttempts: false });
    expect(effective['gan-generator']).toBe(3);

    // And the at-ceiling preserved count re-halts via the shipped check.
    expect(
      checkRoleCeiling({
        role: 'gan-generator',
        attemptState: { attemptCount: effective['gan-generator']!, highestAttemptNumber: 3 },
      }).halt,
    ).toBe(true);
  });
});

describe('recovery_counter_mapping_resists_prototype_pollution', () => {
  it('a __proto__-named role does not pollute, crash, or shadow real roles (reset=false and reset=true)', () => {
    const before = ({} as Record<string, unknown>)['polluted'];

    // A hostile reconstructed state carrying pollution-named "roles". (These
    // can only arrive as adversarial trace data; reconstructRecoveryState
    // already skips them, so we plant them directly to exercise the fold guard.)
    const hostile: Record<string, RoleAttemptState> = Object.create(null);
    hostile['__proto__'] = { attemptCount: 99, highestAttemptNumber: 99 };
    hostile['constructor'] = { attemptCount: 99, highestAttemptNumber: 99 };
    hostile['prototype'] = { attemptCount: 99, highestAttemptNumber: 99 };
    hostile['gan-generator'] = { attemptCount: 3, highestAttemptNumber: 3 };
    const state: RecoveryState = { nextSequence: 0, attemptStateByRole: hostile };

    for (const resetAttempts of [false, true]) {
      const effective = effectiveStartingCounters({ recoveryState: state, resetAttempts });

      // No pollution of Object.prototype.
      expect(({} as Record<string, unknown>)['polluted']).toBe(before);
      expect(Object.prototype).not.toHaveProperty('polluted');

      // Null-prototype result; forbidden keys dropped, real role unaffected.
      expect(Object.getPrototypeOf(effective)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(effective, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(effective, 'constructor')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(effective, 'prototype')).toBe(false);
      expect(effective['gan-generator']).toBe(resetAttempts ? 0 : 3);
    }
  });
});

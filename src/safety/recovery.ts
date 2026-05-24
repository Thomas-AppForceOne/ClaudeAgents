/**
 * Recovery integration — the framework-owned pure pieces that govern how a
 * loop-halted run resumes under `--recover`, and the validation that keeps
 * `--reset-attempts` a recover-only modifier.
 *
 * Like the rest of `src/safety`, this module owns no I/O and no state: every
 * export is a pure function over plain data (the per-role attempt accounting
 * `reconstructRecoveryState` derives from the trace, and the parsed recover/
 * reset-attempts flag booleans). The orchestrator's full `--recover` execution
 * is a future recovery flow; this module owns only the recovery *semantics* a
 * resumed sprint must obey, so they live here as testable library code the
 * orchestrator composes rather than re-implements.
 *
 * Three decisions this module encodes, with their rationale (so a reader
 * understands them):
 *
 * - **`--reset-attempts` is valid only with `--recover` (standalone use is an
 *   error).** A fresh-counter request must be an explicit, recover-scoped
 *   opt-in. The ceiling exists to stop an unproductive loop; a counter reset
 *   that could be requested outside a recovery would be a silent way to defeat
 *   that ceiling, so the framework rejects it as a usage error rather than
 *   honouring it.
 *
 * - **Recovery preserves the trace-reconstructed counters by default** — silent
 *   counter resets defeat the purpose of the ceiling. A recovered sprint
 *   already at its per-role ceiling must halt again on the very next
 *   attempt-start check unless the user explicitly asked for fresh counters —
 *   the ceiling has to survive a resume or it is meaningless. The effective
 *   starting counters are therefore the preserved reconstructed counts (reset
 *   off) or zero (reset on), and feeding them into the shipped
 *   `checkRoleCeiling` is what produces the immediate re-halt.
 *
 * - **Counters come only from the trace, never a sidecar file.** The trace is
 *   the single source of truth so `--recover` can reconstruct counter state
 *   from the event log alone. This module reads attempt counts solely through
 *   `reconstructRecoveryState`'s {@link RoleAttemptState}; introducing a
 *   separate counter file would create a second source of truth recovery could
 *   not rebuild — exactly what the trace-as-only-counter design forbids.
 */

import { createError, type ConfigServerError } from '../config-server/errors.js';
import type { RecoveryState, RoleAttemptState } from '../trace/reconcile.js';

// Role keys that must never index a role-keyed accumulator: they are the
// prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/trace/reconcile.ts` and `FORBIDDEN_ROLE_KEYS` in `./loop-detection.ts`,
// `./sprint-budget.ts`, and `./config.ts`, so this mapping reuses the
// established guard rather than inventing a parallel one. `reconstructRecoveryState`
// already skips these as role names, so such a key can only reach the
// effective-counter fold as hostile data in the trace, never as a real agent.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The kebab-case `terminalReason` a loop halt records on the run's terminal
 * state so the halted run is recoverable.
 *
 * **Why exactly this literal:** `terminalReason` codes are kebab-case ASCII
 * matching the existing recoverable-terminal convention, and `failed-loop-detected`
 * is the loop-halt code. The `--recover` flow keys on this string to know the
 * run terminated on a loop halt (rather than a contract/validation failure) and
 * is therefore resumable. Frozen at the literal — a divergent spelling
 * (camelCase, a different word) would make the halted run un-discoverable to
 * recovery.
 */
export const FAILED_LOOP_DETECTED_TERMINAL_REASON = 'failed-loop-detected';

/**
 * Result of validating the recover/reset-attempts flag pair.
 *
 * @property ok `true` when the flag combination is permitted; `false` when
 *   `--reset-attempts` was passed without `--recover`.
 * @property error present only when `ok` is `false`: the framework structured
 *   error describing the standalone-use rejection (a constructed, not thrown,
 *   {@link ConfigServerError} carrying the `MalformedInput` usage code).
 */
export interface ResetAttemptsValidation {
  ok: boolean;
  error?: ConfigServerError;
}

/**
 * Inputs to {@link validateResetAttemptsUsage}: the parsed flag booleans.
 *
 * @property recover whether `--recover` was passed.
 * @property resetAttempts whether `--reset-attempts` was passed.
 */
export interface ResetAttemptsFlags {
  recover: boolean;
  resetAttempts: boolean;
}

/**
 * Validate that `--reset-attempts` is used only as a `--recover` modifier.
 *
 * The check is a pure function over the parsed flag set so it is unit-testable
 * without executing any `--recover` orchestrator flow. `--reset-attempts`
 * standalone (without `--recover`) is the single rejected combination; passing
 * both, `--recover` alone, or neither is permitted.
 *
 * **Why standalone use is rejected:** see this module's docblock — a
 * fresh-counter request must be an explicit, recover-scoped opt-in, because a
 * counter reset reachable outside recovery would be a silent way to defeat the
 * per-role ceiling the safety layer exists to enforce.
 *
 * @param flags the parsed `--recover` / `--reset-attempts` booleans.
 * @returns a {@link ResetAttemptsValidation}: `{ ok: true }` when permitted, or
 *   `{ ok: false, error }` carrying a framework {@link ConfigServerError} with
 *   code `MalformedInput` (the bad-args/usage class the exit-code table maps to
 *   `EXIT_BAD_ARGS`). Pure; never throws — the error is constructed, not raised,
 *   so the caller decides whether to throw it or fold it into a report.
 */
export function validateResetAttemptsUsage(flags: ResetAttemptsFlags): ResetAttemptsValidation {
  // The only invalid combination: reset requested without a recovery to modify.
  // Both-set / recover-only / neither are all permitted, so the guard is a
  // single conjunction rather than a table.
  if (flags.resetAttempts && !flags.recover) {
    return {
      ok: false,
      error: createError('MalformedInput', {
        // User-facing prose, kept ecosystem-neutral per the framework's
        // error-text discipline: it names no maintainer-only script and no
        // runtime tooling, refers to "the framework"/"ClaudeAgents", and states
        // the correct usage so a developer who has only installed the framework
        // can act on it.
        message:
          'ClaudeAgents cannot apply --reset-attempts on its own: it is valid only as a ' +
          'modifier to --recover. Re-run with both --recover and --reset-attempts to resume a ' +
          'halted run with attempt counters reset to zero, or drop --reset-attempts to recover ' +
          'with the counters the framework reconstructs from the run trace.',
        field: '--reset-attempts',
        remediation:
          'Pass --reset-attempts only together with --recover, or remove it to preserve the ' +
          'reconstructed attempt counters.',
      }),
    };
  }
  return { ok: true };
}

/**
 * A minimal recoverable terminal-state record for a loop-halted run.
 *
 * This is the terminal-reason record — the fields the `--recover` flow reads to
 * know the run is a recoverable loop halt — not the full archive. The full
 * archive flow is later recovery work; this module owns only that the terminal
 * record carries the correct kebab-case reason and is marked terminal in the
 * recoverable sense.
 *
 * @property terminal always `true`: a loop halt ends the run (the sprint did
 *   not converge), so the run is in a terminal state.
 * @property terminalReason the kebab-case loop-halt reason; always
 *   {@link FAILED_LOOP_DETECTED_TERMINAL_REASON}. This is what makes the halted
 *   run discoverable to `--recover` as a loop halt rather than a contract/
 *   validation failure.
 */
export interface LoopHaltTerminalRecord {
  terminal: true;
  terminalReason: typeof FAILED_LOOP_DETECTED_TERMINAL_REASON;
}

/**
 * Build the terminal-state record for a loop halt.
 *
 * Produced when a `LoopDetected` halt fires (any of the three triggers), this
 * is the record whose `terminalReason` makes the run recoverable via
 * `--recover`. It is a pure builder over no inputs — the only fact it carries is
 * the fixed reason — so it can be unit-tested in isolation without the
 * archive/`--recover` execution flow.
 *
 * @returns a {@link LoopHaltTerminalRecord} with `terminal: true` and
 *   `terminalReason: "failed-loop-detected"`. A fresh object each call (never a
 *   shared mutable singleton). Pure; never throws.
 */
export function buildLoopHaltTerminalRecord(): LoopHaltTerminalRecord {
  return {
    terminal: true,
    terminalReason: FAILED_LOOP_DETECTED_TERMINAL_REASON,
  };
}

/**
 * Inputs to {@link effectiveStartingCounters}.
 *
 * @property recoveryState the {@link RecoveryState} reconstructed from the run's
 *   trace by `reconstructRecoveryState` — the *only* source of attempt counts
 *   (no separate counter file). The mapping reads its `attemptStateByRole`.
 * @property resetAttempts the `--reset-attempts` flag: `false` (the default)
 *   preserves the reconstructed counts; `true` zeroes every role's effective
 *   starting count.
 */
export interface EffectiveStartingCountersInput {
  recoveryState: RecoveryState;
  resetAttempts: boolean;
}

/**
 * Map a trace-reconstructed {@link RecoveryState} and the `--reset-attempts`
 * flag to the effective per-role starting attempt counts a recovered sprint
 * resumes with.
 *
 * The result is keyed by role and holds exactly the {@link RoleAttemptState}
 * `attemptCount` semantics `checkRoleCeiling` consumes, so the caller feeds each
 * role's effective count straight into the shipped ceiling check rather than
 * re-deriving a parallel ceiling decision:
 *
 * - **`resetAttempts === false` (default): counters preserved.** Each role's
 *   effective count is its reconstructed `attemptCount`. A recovered sprint
 *   already at its ceiling therefore halts on the very next attempt-start
 *   check — the by-design guarantee that a loop halt is not silently undone
 *   by resuming (see the module docblock).
 * - **`resetAttempts === true`: counters zeroed.** Every role's effective count
 *   is `0`, so the recovered sprint behaves like a fresh sprint and does not
 *   immediately halt. This is the only behaviour the flag changes; the
 *   reconstructed state is identical in both branches.
 *
 * The returned map is a null-prototype object built with the established
 * forbidden-key + `Object.defineProperty` discipline (mirroring
 * `foldRoleCeilings` in `./config.ts` and the guard in `src/trace/reconcile.ts`)
 * so a `__proto__`/`constructor`/`prototype`-named role — which can only reach
 * here as hostile trace data — cannot pollute `Object.prototype`, crash the
 * fold, or shadow a genuine role's effective count.
 *
 * @param input see {@link EffectiveStartingCountersInput}.
 * @returns a role → effective-starting-count map (null-prototype). Pure; never
 *   throws.
 */
export function effectiveStartingCounters(
  input: EffectiveStartingCountersInput,
): Record<string, number> {
  const { recoveryState, resetAttempts } = input;
  // Null-prototype accumulator so a role literally named e.g. "constructor"
  // cannot collide with an inherited Object member while folding.
  const out: Record<string, number> = Object.create(null) as Record<string, number>;

  const byRole = recoveryState.attemptStateByRole;
  for (const role of Object.keys(byRole)) {
    // Defence-in-depth: reconstructRecoveryState already skips these as role
    // names, so a forbidden key here is hostile trace data, never a real agent.
    // Skip it before it can index the accumulator.
    if (FORBIDDEN_ROLE_KEYS.has(role)) continue;
    // hasOwnProperty (not `in`) because the source is a null-prototype map and
    // we must not pick up an inherited member as a role.
    if (!Object.prototype.hasOwnProperty.call(byRole, role)) continue;

    const state: RoleAttemptState | undefined = byRole[role];
    // With reset, every role starts at zero; without it, the reconstructed
    // count is preserved verbatim — this single line is the preserve-vs-zero
    // lever the recovery semantics rest on.
    const effective = resetAttempts ? 0 : state?.attemptCount ?? 0;

    // defineProperty (not assignment) so even a forbidden key reaching this
    // point would create a real own property rather than walking the prototype
    // setter — the same install discipline foldRoleCeilings uses.
    Object.defineProperty(out, role, {
      value: effective,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return out;
}

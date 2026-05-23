/**
 * A1 loop/thrash detection — the framework-owned per-role attempt-ceiling halt
 * primitive.
 *
 * This module is deliberately pure: every export is a function over plain data
 * (an attempt-state map reconstructed from the trace, a ceiling table) with no
 * I/O, so the loop-detection rule can be unit-tested without an orchestrator
 * runtime. The orchestrator composes these functions at attempt-start
 * boundaries (see `skills/gan/SKILL.md`); this file owns only the decision.
 *
 * Why the counters are an *input*, not state owned here: A1 mandates that the
 * trace is the single source of truth for "how many attempts have happened" so
 * that `--recover` can reconstruct counter state from the event log alone. This
 * module therefore consumes the per-role accounting that
 * `reconstructRecoveryState` derives from `agentAttempt` events
 * (`RoleAttemptState` / `attemptStateByRole`) rather than persisting its own
 * counter file. Introducing a sidecar counter would create a second source of
 * truth that recovery could not rebuild — exactly what A1 forbids.
 */

import { createError, type ConfigServerError } from '../config-server/errors.js';
import type { RoleAttemptState } from '../trace/reconcile.js';

// Role keys that must never index a role-keyed accumulator: they are the
// prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/trace/reconcile.ts` so the safety module cannot regress the guard the
// trace layer already establishes. A `__proto__`-named "role" in parsed trace
// data is hostile input, never a real agent.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The two multi-attempt roles that carry a per-role ceiling, with their seed
 * default ceilings.
 *
 * These values are **seed values, not data-derived.** Each ceiling of 3 budgets
 * one initial attempt plus two revision rounds in response to feedback; a fourth
 * attempt at the same step typically signals genuine misalignment (a prompt the
 * agent cannot satisfy) that should surface to the user rather than burn more
 * tokens. A post-release audit re-tunes these against real trace data — until
 * then they are an opinionated guess that errs toward halting early rather than
 * late, and this comment is the rationale a reader gets without the A1 spec.
 *
 * Only these two roles appear: single-attempt roles (clarifier, planner) run
 * once by definition, and the once-per-output roles (reviewer, evaluator) are
 * bounded by the proposer/generator ceilings — none of them is subject to a
 * per-role ceiling, so none of them belongs in this table. Frozen so the seed
 * defaults cannot be mutated at runtime.
 */
export const DEFAULT_ATTEMPT_CEILINGS: Readonly<Record<string, number>> = Object.freeze({
  'gan-contract-proposer': 3,
  'gan-generator': 3,
});

/**
 * The `reason` discriminator on a {@link LoopDetectedFields} error. Sprint 1
 * implements only `roleCeilingExceeded`; the other values are reserved by A1
 * (`sprintBudgetExceeded`, `editOscillation`) and by T3
 * (`tokenBudgetExceeded`, `wallClockBudgetExceeded`) and land in later work.
 */
export type LoopDetectedReason =
  | 'roleCeilingExceeded'
  | 'sprintBudgetExceeded'
  | 'editOscillation';

/**
 * One attempt's entry in the `roleCeilingExceeded` evidence array.
 *
 * @property attemptNumber 1-based ordinal of the attempt within the role's
 *   history (an integer).
 * @property outputArtifactPath relative POSIX path (no leading separator) to the
 *   artefact that attempt produced, for the user to inspect.
 * @property summary a short human note describing the attempt's outcome.
 */
export interface RoleCeilingEvidenceEntry {
  attemptNumber: number;
  outputArtifactPath: string;
  summary: string;
}

/**
 * The structured fields carried on a `LoopDetected` error for the
 * `roleCeilingExceeded` discriminator, matching A1's "Halt contract" field list.
 *
 * @property reason the discriminator; `roleCeilingExceeded` for a per-role halt.
 * @property role the kebab-case role id that hit its ceiling.
 * @property attempts how many attempts had been made when the halt fired.
 * @property ceiling the configured ceiling that was reached.
 * @property evidence one {@link RoleCeilingEvidenceEntry} per attempt.
 */
export interface LoopDetectedFields {
  reason: LoopDetectedReason;
  role: string;
  attempts: number;
  ceiling: number;
  evidence: RoleCeilingEvidenceEntry[];
}

/**
 * Narrow an arbitrary value to a single {@link RoleCeilingEvidenceEntry}.
 *
 * @param value the candidate, typically parsed from untrusted trace data.
 * @returns `true` iff `value` is an object with an integer `attemptNumber`, a
 *   string `outputArtifactPath`, and a string `summary`. Pure; never throws.
 */
export function isRoleCeilingEvidenceEntry(value: unknown): value is RoleCeilingEvidenceEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.attemptNumber === 'number' &&
    Number.isInteger(v.attemptNumber) &&
    typeof v.outputArtifactPath === 'string' &&
    typeof v.summary === 'string'
  );
}

/**
 * Validate a `roleCeilingExceeded` evidence value against its discriminator
 * shape: an array with one well-formed {@link RoleCeilingEvidenceEntry} per
 * attempt.
 *
 * @param value the candidate evidence value.
 * @returns `true` iff `value` is an array in which every element satisfies
 *   {@link isRoleCeilingEvidenceEntry}. An empty array is valid (zero attempts).
 *   Pure; never throws.
 */
export function isRoleCeilingEvidence(value: unknown): value is RoleCeilingEvidenceEntry[] {
  return Array.isArray(value) && value.every(isRoleCeilingEvidenceEntry);
}

/**
 * The outcome of a per-role ceiling check.
 *
 * @property halt whether the role has reached or exceeded its ceiling.
 * @property fields present only when `halt` is `true`: the structured
 *   `LoopDetected` fields describing the halt.
 */
export interface CeilingDecision {
  halt: boolean;
  fields?: LoopDetectedFields;
}

/**
 * Inputs to {@link checkRoleCeiling}.
 *
 * @property role the kebab-case role id being checked.
 * @property attemptState the role's reconstructed attempt accounting (from the
 *   trace via `reconstructRecoveryState`), or `undefined` if the role has no
 *   attempts yet.
 * @property ceilings the per-role ceiling table to consult; defaults to
 *   {@link DEFAULT_ATTEMPT_CEILINGS} when omitted.
 * @property evidence the per-attempt evidence to attach when a halt fires;
 *   defaults to `[]`. Supplied by the caller because the artefact paths and
 *   summaries live in the trace, not in the attempt counts this module sees.
 */
export interface CheckRoleCeilingInput {
  role: string;
  attemptState: RoleAttemptState | undefined;
  ceilings?: Readonly<Record<string, number>>;
  evidence?: RoleCeilingEvidenceEntry[];
}

// Read a ceiling for `role` from `ceilings` using hasOwnProperty (not `in`/
// truthiness) so a role name colliding with an inherited Object member cannot
// accidentally resolve a ceiling, and a legitimate ceiling of 0 is not treated
// as absent.
function ceilingFor(
  ceilings: Readonly<Record<string, number>>,
  role: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(ceilings, role)) return undefined;
  const v = ceilings[role];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Decide whether a single role has reached its per-role attempt ceiling.
 *
 * The check is checked at attempt-start boundaries by the orchestrator: it
 * answers "has this role already made enough attempts that the *next* one would
 * exceed its ceiling?" by comparing the reconstructed attempt count against the
 * ceiling. A role with no ceiling in the table (e.g. a single-attempt role) or
 * no attempt state yet never halts.
 *
 * @param input the role, its reconstructed {@link RoleAttemptState}, an optional
 *   ceiling table, and optional evidence to attach.
 * @returns a {@link CeilingDecision}. `halt` is `true` iff the role has a
 *   ceiling and its `attemptCount` has reached (`>=`) it; when halting, `fields`
 *   carries the `LoopDetected` structured fields (`reason:
 *   "roleCeilingExceeded"`). Pure; never throws — a forbidden/`__proto__`-named
 *   role is treated as "no ceiling" (it cannot be a real configured role) and
 *   returns no halt.
 */
export function checkRoleCeiling(input: CheckRoleCeilingInput): CeilingDecision {
  const { role, attemptState } = input;
  const ceilings = input.ceilings ?? DEFAULT_ATTEMPT_CEILINGS;
  const evidence = input.evidence ?? [];

  // A pollution-named role can never be a real configured role; refuse to look
  // it up so it cannot index the ceiling table via an inherited member.
  if (FORBIDDEN_ROLE_KEYS.has(role)) return { halt: false };

  const ceiling = ceilingFor(ceilings, role);
  if (ceiling === undefined) return { halt: false };

  const attempts = attemptState?.attemptCount ?? 0;
  // `>=`, not `>`: the ceiling is the maximum number of attempts allowed, so
  // once the count reaches it the next attempt-start must halt rather than spawn
  // a further attempt.
  if (attempts < ceiling) return { halt: false };

  return {
    halt: true,
    fields: {
      reason: 'roleCeilingExceeded',
      role,
      attempts,
      ceiling,
      evidence,
    },
  };
}

/**
 * Build per-attempt `roleCeilingExceeded` evidence from a role's attempt
 * artefacts.
 *
 * @param attempts an entry per attempt, each pairing the artefact path with a
 *   short summary. The array index drives `attemptNumber` (1-based).
 * @returns a {@link RoleCeilingEvidenceEntry} array in attempt order. Pure;
 *   never throws. Callers source the artefact paths/summaries from the trace's
 *   `agentAttempt` events.
 */
export function buildRoleCeilingEvidence(
  attempts: ReadonlyArray<{ outputArtifactPath: string; summary: string }>,
): RoleCeilingEvidenceEntry[] {
  return attempts.map((a, i) => ({
    attemptNumber: i + 1,
    outputArtifactPath: a.outputArtifactPath,
    summary: a.summary,
  }));
}

/**
 * Render the user-facing prose halt message for a per-role ceiling halt.
 *
 * The message obeys the framework's user-facing-error discipline: it names no
 * maintainer-only scripts and no ecosystem/runtime tooling, refers to "the
 * framework" / "ClaudeAgents", points the user at the run's trace directory (the
 * read-substrate for understanding the halt, since v1.0 ships without a trace
 * command), and tells them to re-run with `--recover` after adjusting the
 * prompt. The trace path is templated, not hardcoded, so the central-store
 * location can be substituted by the caller.
 *
 * @param fields the structured halt fields (role, attempts, ceiling).
 * @param traceDir the run's trace directory path to point the user at.
 * @returns the prose message. Pure; never throws.
 */
export function renderRoleCeilingMessage(
  fields: Pick<LoopDetectedFields, 'role' | 'attempts' | 'ceiling'>,
  traceDir: string,
): string {
  return (
    `ClaudeAgents halted this sprint: the ${fields.role} role made ${fields.attempts} ` +
    `attempts (its ceiling is ${fields.ceiling}) without converging, so the framework ` +
    `stopped it rather than keep retrying a step that is not making progress. ` +
    `Trace files for this run are at ${traceDir}. ` +
    `Adjust the prompt or raise the ceiling, then re-run with --recover to resume.`
  );
}

/**
 * Construct the `LoopDetected` structured error for a per-role ceiling halt.
 *
 * Built through the framework's existing `createError` factory so the halt is a
 * first-class {@link ConfigServerError} (same serialisation/transport as every
 * other framework error). The five A1 halt-contract fields (`reason`, `role`,
 * `attempts`, `ceiling`, `evidence`) ride along as structured context, and the
 * user-facing prose from {@link renderRoleCeilingMessage} becomes the message.
 *
 * @param fields the structured halt fields to attach.
 * @param traceDir the run's trace directory, used to render the message.
 * @returns a constructed (not thrown) `ConfigServerError` with code
 *   `LoopDetected`. Pure; never throws (it constructs, it does not raise).
 */
export function createLoopDetectedError(
  fields: LoopDetectedFields,
  traceDir: string,
): ConfigServerError {
  return createError('LoopDetected', {
    message: renderRoleCeilingMessage(fields, traceDir),
    reason: fields.reason,
    role: fields.role,
    attempts: fields.attempts,
    ceiling: fields.ceiling,
    evidence: fields.evidence,
  });
}
